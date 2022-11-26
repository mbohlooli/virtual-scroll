import {
  Directive,
  DoCheck,
  EmbeddedViewRef,
  Input,
  isDevMode,
  IterableChanges,
  IterableDiffer,
  IterableDiffers,
  NgIterable,
  OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges,
  TemplateRef,
  TrackByFunction,
  ViewContainerRef,
  ViewRef
} from '@angular/core';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { VirtualListItem } from '../virtual-list-item';
import { Recycler } from './recycler';

function sum(arr: number[]) {
  let result = 0;
  for (let i = 0; i < arr.length; i++)
    result += arr[i];
  return result;
}

interface AnchorItem {
  index: number;
  offset: number;
}

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> implements OnChanges, OnInit, DoCheck, OnDestroy {
  @Input('virtualForOf') data!: NgIterable<T>;

  @Input('virtualForTrackBy')
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console && <any>console.warn)
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);

    this._trackByFn = fn;
  }

  @Input('virtualForTombstone') tombstone!: TemplateRef<any>;
  @Input('virtualForTombstoneHeight') tombstoneHeight!: number;

  @Input('virtualForMarginalItemsToRender') marginalItemsToRender: number = 2;

  @Input('virtualForAnimationDuration') animationDuration: number = 200;

  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _collection!: any[];
  // TODO: make an interface for this

  private _scrollY = 0;
  private _anchorItem: AnchorItem = { index: 0, offset: 0 };
  private _containerHeight = 0;
  private _firstItemIndex = 0;
  private _lastItemIndex = 0;
  private _previosFirstIndex = 0;
  private _previosLastIndex = 0;
  private _scrollRunwayEnd = 0;
  private _heights!: number[];
  private _positions: number[] = [];

  private _recycler = new Recycler();
  private _tombstoneRecycler = new Recycler();
  private _loading = true;
  private _isInMeasure = false;
  private _isInLayout = false;
  private _pendingMeasurement!: number;

  constructor(
    private _differs: IterableDiffers,
    private _viewContainerRef: ViewContainerRef,
    private _virtualList: VirtualListComponent,
    private _template: TemplateRef<VirtualListItem>,
    private _renderer: Renderer2
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

  ngOnInit(): void {
    this._virtualList.sizeChange$.subscribe(([width, height]) => {
      this._containerHeight = height;
    });

    this._virtualList.scrollPosition$.subscribe(scrollY => this.requestLayout(scrollY));
  }

  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
  }

  ngOnDestroy(): void {
    this._recycler.clean();
    this._tombstoneRecycler.clean();
  }

  applyChanges(changes: IterableChanges<T>) {
    if (!this._collection)
      this._collection = [];
    if (!this._heights)
      this._heights = [];

    let isMeasurementRequired = false;

    changes.forEachOperation((item, adjustedPreviousIndex, currentIndex) => {
      if (item.previousIndex == null) {
        isMeasurementRequired = true;
        this._collection.splice(currentIndex || 0, 0, item.item);
        this._heights.splice(currentIndex || 0, 0, 0);
      } else if (currentIndex == null) {
        isMeasurementRequired = true;
        this._collection.splice(adjustedPreviousIndex || 0, 1);
        this._heights.splice(adjustedPreviousIndex || 0, 1);
      } else {
        this._collection.splice(currentIndex, 0, this._collection.splice(adjustedPreviousIndex || 0, 1)[0]);
        this._heights.splice(currentIndex, 0, this._heights.splice(adjustedPreviousIndex || 0, 1)[0]);
      }
    });

    changes.forEachIdentityChange((record: any) => {
      this._collection[record.currentIndex] = record.item;
      this._heights[record.currentIndex] = 0;
    });

    for (let i = 0; i < this._collection.length; i++) {
      this._positions[i] = -1;
      this._heights[i] = 0;
    }

    this._renderer.setStyle(this._virtualList.sentinel?.nativeElement, 'transform', `translateY(${this.tombstoneHeight * this._collection.length}px)`);
    this._loading = false;

    if (isMeasurementRequired)
      this.requestMeasure();

    this.requestLayout(this._scrollY);
  }

  requestMeasure() {
    if (this._isInMeasure || this._isInLayout) {
      clearTimeout(this._pendingMeasurement);
      this._pendingMeasurement = window.setTimeout(this.requestMeasure, 60);
      return;
    }
    this.measure();
  }

  requestLayout(scrollY: number) {
    if (this._isInMeasure || this._isInLayout) return;

    this._isInLayout = true;

    if (!this._collection || this._collection.length === 0) {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        this._viewContainerRef.detach(i);
        i--;
      }
      this._isInLayout = false;
      return;
    }

    this.findPositionInRange(scrollY);
    this.layout();
  }

  measure() {

  }

  layout() {
    this.insertViews();

    this._recycler.pruneScrapViews();

    if (!this._collection || this._collection.length == 0) {
      for (let i = 0; i < this._viewContainerRef.length; i++)
        this._viewContainerRef.detach(i--);
      this._isInLayout = false;
      return;
    }

    this.insertViews();

    this._recycler.pruneScrapViews();
    this._isInLayout = false;

    this.positionViews();
  }

  insertViews() {
    // ! Images are messing the height calculation up 
    // ! The nodes doesnt insert in order!!!!!
    // * This approch repeats but it is in order
    // let isScrollUp = this._previosFirstIndex > this._firstItemIndex || this._previosLastIndex > this._lastItemIndex;
    // let isScrollDown = this._previosFirstIndex < this._firstItemIndex || this._previosLastIndex < this._lastItemIndex;
    // let isFastScroll = this._previosFirstIndex > this._lastItemIndex || this._previosLastIndex < this._firstItemIndex;
    //! not so good at the start
    //! initial fast scroll doesn't work so good
    // * This is fine, the only problem is for scrolling top (the curpos is too high?)
    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i);
      this._viewContainerRef.detach(i);
      this._recycler.recycleView(child.context.index, child);
      i--;
    }
    for (let i = this._firstItemIndex; i < this._lastItemIndex; i++) {
      let view = this.getView(i);
      if (!view) continue;
      this.dispatchLayout(view);
    }


    requestAnimationFrame(() => {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        let view = this.getVisibleItem(i);
        view.rootNodes[0].style.position = 'absolute';
        // TODO: think about this if
        if (view && !this._heights[view.context.index]) {
          this._heights[view.context.index] = view.rootNodes[0].offsetHeight;
          // console.log(view.context.index, this._heights[view.context.index]);
        }
      }

    })
    this.positionViews();


    // window.scrollTo({ top: this._scrollY, behavior: 'auto' });
    // console.log(this._firstItemIndex, this._lastItemIndex)
    // for (let i = 0; i < this._viewContainerRef.length; i++) {
    //   if (i == this._firstItemIndex) {
    //     i = this._lastItemIndex - 1;
    //     continue;
    //   }
    //   if (this.getVisibleItem(i)) {
    //     let view = this.getVisibleItem(i);
    //     view.detach();
    //     this._recycler.recycleView(view.context.index, view);
    //   }
    // }

    // for (let i = this._firstItemIndex; i < this._lastItemIndex; i++) {
    //   let view = this.getView(i);
    //   view.rootNodes[0].style.position = 'absolute';
    //   this._viewContainerRef.insert(view);
    // }
  }

  positionViews() {
    this._scrollY = 0;
    for (let i = 0; i < this._anchorItem.index; i++) {
      this._scrollY += this._heights[i];
    }
    this._scrollY += this._anchorItem.offset;

    let currentPosition = this._scrollY - this._anchorItem.offset;
    let i = this._anchorItem.index;
    while (i > this._firstItemIndex)
      currentPosition -= this.getItemHeight(--i);
    while (i < this._firstItemIndex)
      currentPosition += this.getItemHeight(i++);
    // console.log('heights', this._heights);
    // console.log('positions', this._positions);

    for (let i = this._firstItemIndex; i < this._lastItemIndex; i++) {
      // TODO: initialize the positions
      if (currentPosition != this._positions[i])
        this.getVisibleItem(i - this._firstItemIndex).rootNodes[0].style.transform = `translateY(${currentPosition}px)`;
      this._positions[i] = currentPosition;
      currentPosition += this.getItemHeight(i);
    }
  }

  findPositionInRange(scrollY: number) {
    let delta = scrollY - this._scrollY;

    if (scrollY == 0)
      this._anchorItem = { index: 0, offset: 0 };
    else
      this._anchorItem = this.calculateAnchorItem(this._anchorItem, delta);

    this._scrollY = scrollY;

    this._firstItemIndex = this._anchorItem.index;
    this._lastItemIndex = this.calculateAnchorItem(this._anchorItem, this._containerHeight).index;

    this._firstItemIndex = Math.max(0, this._firstItemIndex - this.marginalItemsToRender);
    this._lastItemIndex = Math.min(this._collection.length, this._lastItemIndex + this.marginalItemsToRender);
  }

  calculateAnchorItem(initialAnchor: AnchorItem, delta: number) {
    if (delta == 0) return initialAnchor;

    delta += initialAnchor.offset;
    let i = initialAnchor.index;
    let tombstones = 0;

    if (delta < 0) {
      while (delta < 0 && i > 0 && this.getItemHeight(i - 1)) {
        delta += this.getItemHeight(i - 1);
        i--;
      }
      tombstones = Math.max(-i, Math.ceil(Math.min(0, delta) / this.tombstoneHeight));
    } else {
      while (delta > 0 && i < this._viewContainerRef.length && this.getItemHeight(i) && this.getItemHeight(i) < delta) {
        delta -= this.getItemHeight(i);
        i++;
      }
      if (i >= this._viewContainerRef.length || !this.getItemHeight(i))
        tombstones = Math.floor(Math.max(delta, 0) / this.tombstoneHeight);
    }

    i += tombstones;
    delta -= tombstones * this.tombstoneHeight;
    return { index: i, offset: delta };
  }

  getVisibleItem(index: number) {
    return this._viewContainerRef.get(index) as EmbeddedViewRef<VirtualListItem>;
  }

  getItemHeight(index: number) {
    return this._heights[index] || this.tombstoneHeight;
  }

  getView(index: number): EmbeddedViewRef<VirtualListItem> {
    let view = this._recycler.getView(index) as EmbeddedViewRef<VirtualListItem>;
    let item = this._collection[index];
    let count = this._collection.length;

    if (!view)
      view = this._template.createEmbeddedView(new VirtualListItem(item, index, count));
    else {
      view.context.$implicit = item;
      view.context.index = index;
      view.context.count = count;
    }

    return view;
  }

  dispatchLayout(view: ViewRef, addBefore: boolean = false) {
    if (addBefore)
      this._viewContainerRef.insert(view, 0);
    else
      this._viewContainerRef.insert(view);

    view.reattach();
  }
}
