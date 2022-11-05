import { Directive, DoCheck, EmbeddedViewRef, Input, isDevMode, IterableChanges, IterableDiffer, IterableDiffers, NgIterable, OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges, TemplateRef, TrackByFunction, ViewContainerRef, ViewRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { Recycler } from './recycler';

export class VirtualListItem {
  constructor(public $implicit: any, public index: number, public count: number) {
  }

  get first(): boolean {
    return this.index === 0;
  }

  get last(): boolean {
    return this.index === this.count - 1;
  }

  get even(): boolean {
    return this.index % 2 === 0;
  }

  get odd(): boolean {
    return !this.even;
  }
}

@Directive({
  selector: '[virtualForConstantHeight][virtualForConstantHeightOf]'
})
export class VirtualForConstantHeightDirective<T> implements OnInit, OnChanges, DoCheck, OnDestroy {
  @Input('virtualForConstantHeightOf') data!: NgIterable<T>;

  @Input('virtualForConstantHeightTrackBy')
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console && <any>console.warn)
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);

    this._trackByFn = fn;
  }

  @Input('virtualForConstantHeightTemplate')
  set template(value: TemplateRef<VirtualListItem>) {
    if (value)
      this._template = value;
  }

  @Input('virtualForConstantHeightRowHeight') rowHeight!: number;

  @Input('virtualForLimit') limit: number = 8;

  private _scrollY!: number;

  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _collection!: any[];

  private _firstItemPosition!: number;
  private _lastItemPosition!: number;

  private _containerWidth!: number;
  private _containerHeight!: number;

  private _isInLayout: boolean = false;
  private _isInMeasure: boolean = false;

  private _pendingMeasurement!: number;
  private _loading = false;

  private _recycler = new Recycler();

  private _previousStartIndex = 0;
  private _previousEndIndex = 0;

  constructor(
    private _virtualList: VirtualListComponent,
    private _differs: IterableDiffers,
    private _template: TemplateRef<VirtualListItem>,
    private _viewContainerRef: ViewContainerRef,
    private _renderer: Renderer2,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (!('data' in changes)) return;

    const value = changes['data'].currentValue;
    if (this._differ || !value) return;

    try {
      this._differ = this._differs.find(value).create(this._trackByFn);
    } catch (e) {
      throw new Error(`Cannot find a differ supporting object '${value}' of this type. NgFor only supports binding to Iterables such as Arrays.`);
    }
  }

  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
  }

  ngOnInit(): void {
    this._subscription.add(
      this._virtualList.scrollPosition$
        .subscribe((scrollY) => {
          this._scrollY = scrollY;
          this.requestLayout();
        })
    );
    // TODO: add Size change
    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(([width, height]) => {
        this._containerWidth = width;
        this._containerHeight = height;
        this.requestMeasure();
      })
    );
  }

  ngOnDestroy(): void {
    this._subscription.unsubscribe();
    this._recycler.clean();
  }

  private applyChanges(changes: IterableChanges<T>) {
    if (!this._collection)
      this._collection = [];

    let isMeasurementRequired = false;

    changes.forEachOperation((item, adjustedPreviousIndex, currentIndex) => {
      if (item.previousIndex == null) {
        isMeasurementRequired = true;
        this._collection.splice(currentIndex || 0, 0, item.item);
      } else if (currentIndex == null) {
        isMeasurementRequired = true;
        this._collection.splice(adjustedPreviousIndex || 0, 1);
      } else {
        this._collection.splice(currentIndex, 0, this._collection.splice(adjustedPreviousIndex || 0, 1)[0]);
      }
    });

    changes.forEachIdentityChange((record: any) => {
      this._collection[record.currentIndex] = record.item;
    });

    this._renderer.setStyle(this._virtualList.listHolder?.nativeElement, 'height', `${this._collection.length * this.rowHeight}px`);
    this._loading = false;

    console.log('collection', this._collection);

    if (isMeasurementRequired)
      this.requestMeasure();

    this.requestLayout();
  }

  private requestMeasure() {
    if (this._isInMeasure || this._isInLayout) {
      clearTimeout(this._pendingMeasurement);
      this._pendingMeasurement =
        window.setTimeout(this.requestMeasure, 60);
      return;
    }
    this.measure();
  }

  private requestLayout() {
    if (!this._isInMeasure && this.rowHeight)
      this.layout();
  }

  private measure() {
    this._isInMeasure = true;

    this.calculateScrapViewsLimit();

    this._isInMeasure = false;
    this.requestLayout();
  }

  private layout() {
    if (this._isInLayout) return;

    this._isInLayout = true;
    let { width, height } = this._virtualList.measure();
    this._containerWidth = width;
    this._containerHeight = height;

    if (!this._collection || this._collection.length === 0) {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        this._viewContainerRef.detach(i);
        i--;
      }
      this._isInLayout = false;
      return;
    }

    this.findPositionInRange();
    this.insertViews();

    this._recycler.pruneScrapViews();
    this._isInLayout = false;
    this._previousStartIndex = this._firstItemPosition;
    this._previousEndIndex = this._lastItemPosition;
    let remainder = this._scrollY - this._firstItemPosition * this.rowHeight;
    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<any>;

      //TODO: use the translateX and make a nice grid
      view.rootNodes[0].style.position = `absolute`;
      view.rootNodes[0].style.transform = `translateY(${i * this.rowHeight - remainder + this._scrollY}px)`
    }
  }

  insertViews() {
    let isScrollUp = this._previousStartIndex > this._firstItemPosition || this._previousEndIndex > this._lastItemPosition;
    let isScrollDown = this._previousStartIndex < this._firstItemPosition || this._previousEndIndex < this._lastItemPosition;
    let isFastScroll = this._previousStartIndex > this._lastItemPosition || this._previousEndIndex < this._firstItemPosition;

    if (isFastScroll) {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i);
        this._viewContainerRef.detach(i);
        this._recycler.recycleView(child.context.index, child);
        i--;
      }
      for (let i = this._firstItemPosition; i < this._lastItemPosition; i++) {
        let view = this.getView(i);
        this.dispatchLayout(view);
      }
    } else if (isScrollUp) {
      for (let i = this._previousStartIndex - 1; i >= this._firstItemPosition; i--) {
        let view = this.getView(i);
        this.dispatchLayout(view, true);
      }
      for (let i = this._lastItemPosition; i < this._previousEndIndex; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(this._viewContainerRef.length - 1);
        this._viewContainerRef.detach(this._viewContainerRef.length - 1);
        this._recycler.recycleView(child.context.index, child);
      }
    } else if (isScrollDown) {
      for (let i = this._previousStartIndex; i < this._firstItemPosition; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(0);
        this._viewContainerRef.detach(0);
        this._recycler.recycleView(child.context.index, child);
      }
      for (let i = this._previousEndIndex; i < this._lastItemPosition; i++) {
        let view = this.getView(i);
        this.dispatchLayout(view);
      }
    }
  }

  findPositionInRange() {
    this._firstItemPosition = Math.max(0, Math.floor(this._scrollY / this.rowHeight));
    this._lastItemPosition = Math.min(this._collection.length, Math.ceil((this._scrollY + Math.floor(this._containerHeight)) / this.rowHeight));

    if (!this._loading && this._lastItemPosition == this._collection.length) {
      this._virtualList.onScrollEnd();
      this._loading = true;
    }
  }


  private getView(position: number): ViewRef {
    let view = this._recycler.getView(position);
    let item = this._collection[position];
    let count = this._collection.length;
    if (!view)
      view = this._template.createEmbeddedView(new VirtualListItem(item, position, count));
    else {
      (view as EmbeddedViewRef<VirtualListItem>).context.$implicit = item;
      (view as EmbeddedViewRef<VirtualListItem>).context.index = position;
      (view as EmbeddedViewRef<VirtualListItem>).context.count = count;
    }
    return view;
  }

  // TODO: make default value for addBefore and remove unused arguments
  private dispatchLayout(view: ViewRef, addBefore: boolean = false) {
    if (addBefore)
      this._viewContainerRef.insert(view, 0);
    else
      this._viewContainerRef.insert(view);

    view.reattach();
  }

  private calculateScrapViewsLimit() {
    this._recycler.setScrapViewsLimit(this.limit);
  }
}
