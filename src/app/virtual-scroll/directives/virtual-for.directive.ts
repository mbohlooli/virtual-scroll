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

  @Input('virtualForHeightFn') heightFn!: (index: number) => number;

  @Input('virtualForLimit') limit = 8;

  @Input('virtualForOnScrollEnd') scrollEnd!: () => void;

  @Input('virtualForItemSize') itemSize: number | undefined;

  private _scrollY!: number;

  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _collection!: any[];
  private _heights: number[] = [];
  private _positions: number[] = [];

  private _firstItemPosition!: number;
  private _lastItemPosition!: number;

  private _containerWidth!: number;
  private _containerHeight!: number;

  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _averageHeight: number = 0;

  private _isInLayout: boolean = false;
  private _isInMeasure: boolean = false;
  private _invalidate: boolean = true;

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

    let addedCount = 0;
    changes.forEachOperation((item, adjustedPreviousIndex, currentIndex) => {
      if (item.previousIndex == null) {
        isMeasurementRequired = true;
        this._collection.splice(currentIndex || 0, 0, item.item);
        addedCount++;
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

    if (!this.itemSize) {
      let position = 0;
      for (let i = 0; i < this._collection.length; i++) {
        this._heights[i] = this.heightFn(this._collection[i]);
        this._positions[i] = position;
        position += this._heights[i];
        isMeasurementRequired = true;
      }
      this._averageHeight = Math.floor(sum(this._heights) / this._heights.length);
    } else {
      this._averageHeight = this.itemSize;
    }

    this._paddingBottom += this._averageHeight * addedCount;
    this._renderer.setStyle(this._virtualList.listHolder?.nativeElement, "padding-bottom", `${this._paddingBottom}px`);

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
    if (!this._isInMeasure && ((this._heights && this._heights.length !== 0) || this.itemSize))
      this.layout();
  }

  private measure() {
    this._isInMeasure = true;

    this.calculateScrapViewsLimit();
    this._isInMeasure = false;
    this._invalidate = true;
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
      this._invalidate = false;
      return;
    }

    this.findPositionInRange();
    this.insertViews();

    this._recycler.pruneScrapViews();
    this._isInLayout = false;
    this._invalidate = false;
    this._previousStartIndex = this._firstItemPosition;
    this._previousEndIndex = this._lastItemPosition;

    this._renderer.setStyle(this._virtualList.listHolder?.nativeElement, 'padding-top', `${this._paddingTop}px`);
    this._renderer.setStyle(this._virtualList.listHolder?.nativeElement, 'padding-bottom', `${this._paddingBottom}px`);
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
      this._paddingTop = (this.itemSize) ? this.itemSize * this._firstItemPosition : sum(this._heights.slice(0, this._firstItemPosition));
      this._paddingBottom = this._averageHeight * (this._collection.length - this._lastItemPosition);
    } else if (isScrollUp) {
      for (let i = this._previousStartIndex - 1; i >= this._firstItemPosition; i--) {
        let view = this.getView(i);
        this.dispatchLayout(view, true);
        this._paddingTop -= (this.itemSize) ? this.itemSize : this._heights[i];
      }
      for (let i = this._lastItemPosition; i < this._previousEndIndex; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(this._viewContainerRef.length - 1);
        this._viewContainerRef.detach(this._viewContainerRef.length - 1);
        this._paddingBottom += this._averageHeight;
        this._recycler.recycleView(child.context.index, child);
      }
    } else if (isScrollDown) {
      for (let i = this._previousStartIndex; i < this._firstItemPosition; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(0);
        this._viewContainerRef.detach(0);
        this._paddingTop += (this.itemSize) ? this.itemSize : this._heights[i];
        this._recycler.recycleView(child.context.index, child);
      }
      for (let i = this._previousEndIndex; i < this._lastItemPosition; i++) {
        let view = this.getView(i);
        this.dispatchLayout(view);
        this._paddingBottom -= this._averageHeight;
      }
    }
  }

  findPositionInRange() {
    if (!this.itemSize) {
      this._firstItemPosition = this.findFirstGreaterOrEqual(this._scrollY, 0, this._positions.length);
      this._lastItemPosition = this.findFirstGreaterOrEqual(this._scrollY + window.innerHeight, this._firstItemPosition, this._positions.length);
    } else {
      this._firstItemPosition = Math.floor(this._scrollY / this.itemSize);
      this._lastItemPosition = Math.ceil((this._scrollY + window.innerHeight) / this.itemSize);
    }

    this._firstItemPosition = Math.max(this._firstItemPosition - 1, 0);
    this._lastItemPosition = Math.min(this._lastItemPosition + 1, this._collection.length);

    if (!this._loading && this._lastItemPosition == this._collection.length) {
      this.scrollEnd();
      this._loading = true;
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
