import { Directive, DoCheck, EmbeddedViewRef, Input, isDevMode, IterableChanges, IterableDiffer, IterableDiffers, NgIterable, OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges, TemplateRef, TrackByFunction, ViewContainerRef, ViewRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { VirtualListItem } from '../virtual-list-item';
import { Recycler } from './recycler';

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

  @Input('virtualForConstantHeightRowHeight') rowHeight: number = 0;

  @Input('virtualForConstantHeightRowHeightFn') getRowHeight!: () => number;

  @Input('virtualForConstantHeightLimit') limit: number = 8;

  @Input('virtualForConstantHeightAbsolutePositioning') absolutePositioning: boolean = true;

  @Input('virtualForConstantHeightColumns') columns: number = 1;

  @Input('virtualForConstantHeightColumnsFn') getColumnsFn!: () => number;

  private _collection!: any[];
  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _scrollY!: number;
  private _containerHeight!: number;
  private _rowHeight = 0;
  private _columns = 1;
  private _offsetFromTop = 0;

  private _firstItemPosition!: number;
  private _lastItemPosition!: number;
  private _previousStartIndex: number = 0;
  private _previousEndIndex: number = 0;

  private _isInLayout: boolean = false;
  private _isInMeasure: boolean = false;
  private _pendingMeasurement!: number;
  private _loading: boolean = false;

  private _recycler = new Recycler();

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

    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(([width, height]) => {
        this._containerHeight = height;
        this._columns = (this.getColumnsFn) ? this.getColumnsFn() : this.columns;
        this._rowHeight = this.getRowHeight ? this.getRowHeight() : this.rowHeight;
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

    changes.forEachIdentityChange((record: any) => this._collection[record.currentIndex] = record.item);

    this._renderer.setStyle(this._virtualList.listHolder?.nativeElement, 'height', `${Math.ceil(this._collection.length / this._columns) * this._rowHeight}px`);
    this._loading = false;

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
    if (!this._isInMeasure && this._rowHeight)
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
    let { height } = this._virtualList.measure();
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
    let remainder = this._scrollY - (this._firstItemPosition / this._columns) * this._rowHeight;

    if (!this.absolutePositioning) return;

    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<any>;
      view.rootNodes[0].style.position = `absolute`;
      view.rootNodes[0].style.transform = `translateY(${Math.floor(i / this._columns) * this._rowHeight - remainder + this._scrollY}px)`;
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
        if (!view) continue;
        this.dispatchLayout(view);
      }
      this._offsetFromTop = (this._firstItemPosition / this._columns) * this._rowHeight;
    } else if (isScrollUp) {
      for (let i = this._previousStartIndex - 1; i >= this._firstItemPosition; i--) {
        let view = this.getView(i);
        this.dispatchLayout(view, true);
        this._offsetFromTop -= this._rowHeight / this._columns;
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
        this._offsetFromTop += this._rowHeight / this._columns;
        this._recycler.recycleView(child.context.index, child);
      }
      for (let i = this._previousEndIndex; i < this._lastItemPosition; i++) {
        let view = this.getView(i);
        if (!view) continue;
        this.dispatchLayout(view);
      }
    }

    this.positionViews();
  }

  private findPositionInRange() {
    this._firstItemPosition = Math.max(0, Math.floor(this._scrollY / this._rowHeight) * this._columns);
    this._lastItemPosition = Math.min(this._collection.length, Math.ceil((this._scrollY + Math.floor(this._containerHeight)) / this._rowHeight) * this._columns);

    if (this._loading || this._lastItemPosition != this._collection.length) return;

    this._virtualList.onScrollEnd();
    this._loading = true;
  }

  private positionViews() {
    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<any>;
      if (!view) continue;
      view.rootNodes[0].style.transform = `translateY(${this._offsetFromTop}px)`
    }
  }

  private getView(position: number): ViewRef {
    let view = this._recycler.getView(position) as EmbeddedViewRef<VirtualListItem>;
    let item = this._collection[position];
    let count = this._collection.length;

    if (!view)
      view = this._template.createEmbeddedView(new VirtualListItem(item, position, count));
    else {
      view.context.$implicit = item;
      view.context.index = position;
      view.context.count = count;
    }

    return view;
  }

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
