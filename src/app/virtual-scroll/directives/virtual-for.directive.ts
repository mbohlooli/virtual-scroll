import { Directive, DoCheck, EmbeddedViewRef, Input, isDevMode, IterableChanges, IterableDiffer, IterableDiffers, NgIterable, OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges, TemplateRef, TrackByFunction, ViewContainerRef, ViewRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { Recycler } from './recycler';
import { VirtualListItem } from './virtual-for-constant-height.directive';

function sum(arr: number[]) {
  let result = 0;
  for (let i = 0; i < arr.length; i++)
    result += arr[i];
  return result;
}

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> implements OnInit, OnChanges, DoCheck, OnDestroy {
  @Input('virtualForOf') data!: NgIterable<T>;

  @Input('virtualForTrackBy')
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console && <any>console.warn)
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);

    this._trackByFn = fn;
  }

  @Input('virtualForTemplate')
  set template(value: TemplateRef<VirtualListItem>) {
    if (value)
      this._template = value;
  }

  @Input('virtualForHeightFn') heightFn!: (item: any) => number;

  @Input('virtualForAdditionalItemsToRender') additionalItemsToRender: number = 2;

  @Input('virtualForLimit') limit = 8;

  @Input('virtualForTombstone') tombstone!: TemplateRef<any>;

  @Input('virtualForTombstoneHeight') tombstoneHeight: number = 100;

  private _scrollY!: number;

  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _collection!: any[];
  private _heights: number[] = [];
  private _positions: number[] = [];

  private _firstItemPosition!: number;
  private _lastItemPosition!: number;

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
    console.log('tombstone', this.tombstone, this.tombstoneHeight);
    this._subscription.add(
      this._virtualList.scrollPosition$
        .subscribe((scrollY) => {
          this._scrollY = scrollY;
          this.requestLayout();
        })
    );

    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(() => this.requestMeasure())
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

    let position = this._positions[this._collection.length - 1] || 0;
    changes.forEachAddedItem(({ item }) => {
      this._collection.push(item);
      this._heights.push(this.heightFn(item));
      this._positions.push(position);
      position += this.heightFn(item);
    });

    this._renderer.setStyle(this._virtualList.sentinel.nativeElement, 'transform', `translateY(${sum(this._heights)}px)`);

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
    if (!this._isInMeasure && this._heights && this._heights.length !== 0)
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
    this._previousStartIndex = this._firstItemPosition;
    this._previousEndIndex = this._lastItemPosition;
    this._isInLayout = false;
  }

  insertViews() {
    let isScrollUp = this._previousStartIndex > this._firstItemPosition || this._previousEndIndex > this._lastItemPosition;
    let isScrollDown = this._previousStartIndex < this._firstItemPosition || this._previousEndIndex < this._lastItemPosition;
    let isFastScroll = this._previousStartIndex > this._lastItemPosition || this._previousEndIndex < this._firstItemPosition;

    if (isFastScroll) {
      // TODO: 1- insert some tombstones first based on the scrollTop
      // TODO: 2- start from the previous last index to current first index and insert items one by one and update their positions then detach
      // TODO: 3- insert from first index to last index and update the positions just like scroll down
      // for (let i = 0; i < this._viewContainerRef.length; i++) {
      //   let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i);
      //   this._viewContainerRef.detach(i);
      //   this._recycler.recycleView(child.context.index, child);
      //   i--;
      // }
      // for (let i = this._firstItemPosition; i < this._lastItemPosition; i++) {
      //   let view = this.getView(i);
      //   this.dispatchLayout(view);
      // }
      // this._renderer.setStyle(this._virtualList.sentinel.nativeElement, 'transform', `translateY(${sum(this._heights)}px)`);
    } else if (isScrollUp) {
      // ! Or maybe the problem is here
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
    } else if (isScrollDown) {
      for (let i = this._previousStartIndex; i < this._firstItemPosition; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(0);
        if (!child) continue;
        this._viewContainerRef.detach(0);
        this._recycler.recycleView(child.context.index, child);
      }
      for (let i = this._previousEndIndex; i < this._lastItemPosition; i++) {
        let view = this.getView(i);
        this.dispatchLayout(view);
      }
    }

    if (isScrollDown) {
      let pos = sum(this._heights.slice(0, this._firstItemPosition));
      for (let i = this._firstItemPosition; i < this._lastItemPosition; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i - this._firstItemPosition);
        if (!child) continue;
        this._positions[i] = pos;
        child.rootNodes[0].style.transform = `translateY(${pos}px)`;
        pos += child.rootNodes[0].offsetHeight ? child.rootNodes[0].offsetHeight : this._heights[i];
        this._heights[i] = child.rootNodes[0].offsetHeight ? child.rootNodes[0].offsetHeight : this._heights[i];
      }

      this._renderer.setStyle(this._virtualList.sentinel.nativeElement, 'transform', `translateY(${sum(this._heights)}px)`);
    } else if (isScrollUp) {
      for (let i = this._firstItemPosition; i < this._lastItemPosition; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i - this._firstItemPosition);
        if (!child) continue;
        child.rootNodes[0].style.transform = `translateY(${this._positions[i]}px)`;
      }
    } else if (isFastScroll) {


    }

    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<VirtualListItem>;
      if (view.context.index >= this._lastItemPosition || view.context.index < this._firstItemPosition) {
        view.detach();
        this._recycler.recycleView(view.context.index, view);
      }
    }

    // TODO: make scrolltop better
    // TODO: fix the fast scrolling
    // TODO: fix the fliker at start
    // TODO: anchor item
    if (this._scrollY <= 0) {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        let view = this._viewContainerRef.get(i) as EmbeddedViewRef<VirtualListItem>;
        view.rootNodes[0].style.position = 'static';
        view.rootNodes[0].style.transform = 'none';
      }
    }

    console.log(this._positions)
  }

  findPositionInRange() {
    if (this._previousEndIndex != 0) {
      this._previousStartIndex = this._firstItemPosition;
      this._previousEndIndex = this._lastItemPosition;
    }
    this._firstItemPosition = this.findFirstGreaterOrEqual(this._scrollY, 0, this._positions.length);
    this._lastItemPosition = this.findFirstGreaterOrEqual(this._scrollY + window.innerHeight, this._firstItemPosition, this._positions.length);
    // ! OR maybe here
    this._firstItemPosition = Math.max(this._firstItemPosition - this.additionalItemsToRender, 0);
    this._lastItemPosition = Math.min(this._lastItemPosition + this.additionalItemsToRender, this._collection.length);

    if (!this._loading && this._lastItemPosition == this._collection.length) {
      this._loading = true;
      this._virtualList.onScrollEnd();
    }
  }

  findFirstGreaterOrEqual(value: number, start: number, end: number): number {
    if (start > end) return end;

    let mid = Math.floor((start + end) / 2);
    if (mid == 0) return 0;

    if (this._positions[mid - 1] < value && this._positions[mid] >= value) return mid;

    if (this._positions[mid] > value)
      return this.findFirstGreaterOrEqual(value, start, mid - 1);

    return this.findFirstGreaterOrEqual(value, mid + 1, end);
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
    (view as EmbeddedViewRef<VirtualListItem>).rootNodes[0].style.position = 'absolute';
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
