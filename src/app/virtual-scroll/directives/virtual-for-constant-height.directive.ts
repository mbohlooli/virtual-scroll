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
  OnChanges,
  OnDestroy,
  OnInit,
  Renderer2,
  SimpleChanges,
  TemplateRef,
  TrackByFunction,
  ViewContainerRef,
  ViewRef
} from '@angular/core';
import { Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { VirtualListItem } from '../virtual-list-item';
import { Recycler } from './recycler';

@Directive({
  selector: '[virtualForConstantHeight][virtualForConstantHeightOf]'
})
export class VirtualForConstantHeightDirective<T> implements OnInit, OnChanges, DoCheck, OnDestroy {
  // The datasource for list
  @Input('virtualForConstantHeightOf') data!: NgIterable<T>;

  // trackBy function
  @Input('virtualForConstantHeightTrackBy')
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console && <any>console.warn)
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);

    this._trackByFn = fn;
  }

  // The template of each list item
  @Input('virtualForConstantHeightTemplate')
  set template(value: TemplateRef<VirtualListItem>) {
    if (value)
      this._template = value;
  }

  // The height of each list item (use when the height of each element doesn't depend on the screen size)
  @Input('virtualForConstantHeightRowHeight') rowHeight: number = 0;

  // returns the height of each list item (use for responsive layouts when the height of each element depends on screen size)
  @Input('virtualForConstantHeightRowHeightFn') getRowHeight!: () => number;

  // recyler maximum limit
  @Input('virtualForConstantHeightLimit') limit: number = 8;

  // Set to true if we have a grid list
  @Input('virtualForConstantHeightAbsolutePositioning')
  set grid(isGrid: boolean) {
    this._absolutePositioning = !isGrid;
  }

  // The number of columns for grid list (use when the columns count doesn't depend on the screen size)
  @Input('virtualForConstantHeightColumns') columns: number = 1;

  // returns the number of columns for grid list (use for responsive layouts when the columns count depends on the screen size)
  @Input('virtualForConstantHeightColumnsFn') getColumnsFn!: () => number;

  // An internal copy of datasource
  private _collection!: any[];
  // Used for detecting changes in datasource in an officient way
  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _scrollY!: number;
  private _containerHeight!: number;
  private _rowHeight = 0;
  private _columns = 1;
  // Used for positioning grid items (used only for grid lists (columns > 1))
  private _offsetFromTop = 0;

  private _firstVisibleItemIndex!: number;
  private _lastItemVisibleIndex!: number;
  private _previousStartIndex: number = 0;
  private _previousEndIndex: number = 0;

  // true if the directive is changing layout
  private _isInLayout: boolean = false;
  // true if the directive is doing a measure
  private _isInMeasure: boolean = false;
  // The next measurement to be performed
  private _pendingMeasurement!: number;
  // True while waiting for fetching new items from datasource
  private _loading: boolean = false;
  // If set to false, then we have a grid list
  private _absolutePositioning: boolean = true;

  // Recycler
  private _recycler = new Recycler();

  constructor(
    // Wrapper
    private _virtualList: VirtualListComponent,
    // An "IterableDiffer" factory for getting the _differ
    private _differs: IterableDiffers,
    // The template of each list item
    private _template: TemplateRef<VirtualListItem>,
    // An abstraction for runway containing all visible elements in dom
    private _viewContainerRef: ViewContainerRef,
    // use for setting styles on html elements
    private _renderer: Renderer2,
  ) { }

  // Checking for changes in data
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

  // check for changes in data based on "IterableDiffer"
  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
  }

  // Listening to scroll and size change emitted from "VirtualListComponent" 
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

  // React to changes to datasource
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

  // Changing the DOM
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
    this._previousStartIndex = this._firstVisibleItemIndex;
    this._previousEndIndex = this._lastItemVisibleIndex;
    let remainder = this._scrollY - (this._firstVisibleItemIndex / this._columns) * this._rowHeight;

    if (!this._absolutePositioning) return;

    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<any>;
      view.rootNodes[0].style.position = `absolute`;
      view.rootNodes[0].style.transform = `translateY(${Math.floor(i / this._columns) * this._rowHeight - remainder + this._scrollY}px)`;
    }
  }

  // Adding the new items to DOM and removing invisible ones from DOM based on scroll direction or type
  insertViews() {
    let isScrollUp = this._previousStartIndex > this._firstVisibleItemIndex || this._previousEndIndex > this._lastItemVisibleIndex;
    let isScrollDown = this._previousStartIndex < this._firstVisibleItemIndex || this._previousEndIndex < this._lastItemVisibleIndex;
    let isFastScroll = this._previousStartIndex > this._lastItemVisibleIndex || this._previousEndIndex < this._firstVisibleItemIndex;

    if (isFastScroll) {
      for (let i = 0; i < this._viewContainerRef.length; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(i);
        this._viewContainerRef.detach(i);
        this._recycler.recycleView(child.context.index, child);
        i--;
      }
      for (let i = this._firstVisibleItemIndex; i < this._lastItemVisibleIndex; i++) {
        let view = this.getView(i);
        if (!view) continue;
        this.dispatchLayout(view);
      }
      this._offsetFromTop = (this._firstVisibleItemIndex / this._columns) * this._rowHeight;
    } else if (isScrollUp) {
      for (let i = this._previousStartIndex - 1; i >= this._firstVisibleItemIndex; i--) {
        let view = this.getView(i);
        this.dispatchLayout(view, true);
        this._offsetFromTop -= this._rowHeight / this._columns;
      }
      for (let i = this._lastItemVisibleIndex; i < this._previousEndIndex; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(this._viewContainerRef.length - 1);
        this._viewContainerRef.detach(this._viewContainerRef.length - 1);
        this._recycler.recycleView(child.context.index, child);
      }
    } else if (isScrollDown) {
      for (let i = this._previousStartIndex; i < this._firstVisibleItemIndex; i++) {
        let child = <EmbeddedViewRef<VirtualListItem>>this._viewContainerRef.get(0);
        this._viewContainerRef.detach(0);
        this._offsetFromTop += this._rowHeight / this._columns;
        this._recycler.recycleView(child.context.index, child);
      }
      for (let i = this._previousEndIndex; i < this._lastItemVisibleIndex; i++) {
        let view = this.getView(i);
        if (!view) continue;
        this.dispatchLayout(view);
      }
    }

    this.positionViews();
  }

  // Calculate the range of visible items in screen
  private findPositionInRange() {
    this._firstVisibleItemIndex = Math.max(0, Math.floor(this._scrollY / this._rowHeight) * this._columns);
    this._lastItemVisibleIndex = Math.min(this._collection.length, Math.ceil((this._scrollY + Math.floor(this._containerHeight)) / this._rowHeight) * this._columns);

    if (this._loading || this._lastItemVisibleIndex != this._collection.length) return;

    this._virtualList.onScrollEnd();
    this._loading = true;
  }

  // Positions a grid list items (No effect on non-grid lists (columns = 1))
  private positionViews() {
    for (let i = 0; i < this._viewContainerRef.length; i++) {
      let view = this._viewContainerRef.get(i) as EmbeddedViewRef<any>;
      if (!view) continue;
      view.rootNodes[0].style.transform = `translateY(${this._offsetFromTop}px)`
    }
  }

  // Creates a new view if recycler is empty otherwise gets view from recycler and changes the bindings
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

  // inserting a view into DOM
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
