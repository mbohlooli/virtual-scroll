import {
  Directive, DoCheck, EmbeddedViewRef, Input, isDevMode, IterableChanges, IterableDiffer, IterableDiffers, NgIterable, OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges, TemplateRef, TrackByFunction, ViewContainerRef
} from '@angular/core';
import { Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { VirtualListItem } from '../virtual-list-item';

interface ListItem {
  data: any,
  node: any,
  height: number,
  width: number,
  top: number
}

interface ScrollAnchor {
  index: number,
  offset: number
}

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> implements OnInit, OnChanges, DoCheck, OnDestroy {
  @Input('virtualForOf') data!: NgIterable<T>;

  @Input('virtualForTombstone') tombstone!: TemplateRef<VirtualListItem>;

  //? trackBy function
  @Input('virtualForTrackBy')
  set trackBy(fn: TrackByFunction<T>) {
    if (isDevMode() && fn != null && typeof fn !== 'function' && <any>console && <any>console.warn)
      console.warn(`trackBy must be a function, but received ${JSON.stringify(fn)}.`);

    this._trackByFn = fn;
  }

  @Input('virtualForMarginalItemsToRender') marginalItemsToRender: number = 1;

  @Input('virtualForAdditionalScroll') additionalScroll: number = 0;

  @Input('virtualForAnimatioinDurationMs') animationDurationMs = 200;

  @Input('virtualForHasMore') hasMore!: boolean;


  //? An internal copy of datasource
  private _items: ListItem[] = [];
  //? Used for detecting changes in datasource in an officient way
  private _differ!: IterableDiffer<T>;
  private _trackByFn!: TrackByFunction<T>;
  private _subscription: Subscription = new Subscription();

  private _anchorItem: ScrollAnchor = { index: 0, offset: 0 };
  private _anchorScrollTop: number = 0;
  private _scrollRunwayEnd: number = 0;

  private _firstAttachedItem: number = 0;
  private _lastAttachedItem: number = 0;

  private _tombstoneHeight: number = 0;
  private _tombstoneWidth: number = 0;

  private _tombstonesRecycler: any[] = [];
  private _recycler: any[] = [];

  private _loadedItems: number = 0;
  private _requestInProgress: boolean = false;


  constructor(
    //? Wrapper
    private _virtualList: VirtualListComponent,
    //? An "IterableDiffer" factory for getting the _differ
    private _differs: IterableDiffers,
    //? The template of each list item
    private _template: TemplateRef<VirtualListItem>,
    //? An abstraction for runway containing all visible elements in dom
    private _viewContainerRef: ViewContainerRef,
    //? use for setting styles on html elements
    private _renderer: Renderer2,
  ) { }

  //? Checking for changes in data
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

  //? check for changes in data based on "IterableDiffer"
  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
    // for (let i = 0; i < this._items.length; i++) {
    //   let view = this._viewContainerRef.createEmbeddedView(this._template);
    //   view.context.$implicit = this._items[i];
    //   view.context.index = i;
    // }
  }

  //? Listening to scroll and size change emitted from "VirtualListComponent" 
  ngOnInit(): void {
    this._subscription.add(
      this._virtualList.scrollPosition$.subscribe((scrollY) => this.onScroll())
    );

    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(([width, height]) => {
        let tombstone = this.createTombstone();
        tombstone.rootNodes[0].style.position = 'absolute';
        this._viewContainerRef.insert(tombstone);
        tombstone.rootNodes[0].style.display = 'unset';
        this._tombstoneWidth = tombstone.rootNodes[0].offsetWidth;
        this._tombstoneHeight = tombstone.rootNodes[0].offsetHeight + 14;
        this._viewContainerRef.detach(this._viewContainerRef.length-1);

        for (let i = 0; i < this._items.length; i++)
          this._items[i].width = this._items[i].height = 0;

        this.onScroll();
      })
    );
  }

  ngOnDestroy(): void {
    this._subscription.unsubscribe();
    this._tombstonesRecycler = [];
    this._recycler = [];
  }

  //? React to changes to datasource
  private applyChanges(changes: IterableChanges<T>) {
    if (!this._items)
      this._items = [];

    let isMeasurementRequired = false;

    changes.forEachOperation(({item, previousIndex}, adjustedPreviousIndex, currentIndex) => {
      if (previousIndex == null) {
        isMeasurementRequired = true;
        this._items.splice(currentIndex || 0, 0, {data: item, height: 0, node: null, top: 0, width: 0});
      } else if (currentIndex == null) {
        isMeasurementRequired = true;
        this._items.splice(adjustedPreviousIndex || 0, 1);
      } else {
        this._items.splice(currentIndex, 0, this._items.splice(adjustedPreviousIndex || 0, 1)[0]);
      }
    });

    changes.forEachIdentityChange((record: any) => this._items[record.currentIndex] = record.item);
    
    this._requestInProgress = false;
    this._loadedItems = this._items.length;
    
    this.onScroll();
  }

  onScroll() {
    let scrollTop = this._virtualList.scrollTop;
    let delta = scrollTop - this._anchorScrollTop;

    if (scrollTop == 0)
      this._anchorItem = {index: 0, offset: 0};
    else
      this._anchorItem = this.calculateAnchorItem(this._anchorItem, delta);

    this._anchorScrollTop = scrollTop;
    let { index: lastIndex } = this.calculateAnchorItem(this._anchorItem, this._virtualList.measure().height);

    this.fill(this._anchorItem.index - this.marginalItemsToRender, lastIndex + this.marginalItemsToRender);
  }

  calculateAnchorItem(currentAnchor: ScrollAnchor, delta: number): ScrollAnchor {
    if (delta == 0) return currentAnchor;
    
    delta += currentAnchor.offset;
    let i = currentAnchor.index;
    let tombstones = 0;

    if (delta < 0) {
      while (i > 0 && delta < 0 && this._items[i].height)
        delta += this._items[--i].height;
      tombstones = Math.max(-i, Math.ceil(Math.min(0, delta)/this._tombstoneHeight));
    } else {
      while (i < this._items.length && delta > 0 && this._items[i].height)
        delta -= this._items[i++].height;
      if (i >= this._items.length || !this._items[i].height)
        tombstones = Math.floor(Math.max(0, delta)/this._tombstoneHeight);
    }

    i += tombstones;
    return {index: i, offset: delta};
  }

  fill(start: number, end: number) {
    this._firstAttachedItem = Math.max(0, start);
    this._lastAttachedItem = end;
    this.attachContent();
  }

  attachContent() {
    if (this._items.length == 0) return;

    for (let i = 0; i < this._items.length; i++) {
      if (i == this._firstAttachedItem) {
        i = this._lastAttachedItem - 1;
        continue;
      }
      if (this._items[i].node) {
        if (this._items[i].node?.rootNodes[0].classList.contains('tombstone')) {
          this._tombstonesRecycler.push(this._items[i].node);
          this._items[i].node.rootNodes[0].style.display = 'none';
        } else {
          this._recycler.push(this._items[i].node);
          this._viewContainerRef.detach(this._viewContainerRef.indexOf(this._items[i].node))
        }
        this._items[i].node = null;
      }
    }

    let tombstoneAnimations: {[key: number]: [any, number]} = {};
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      while (this._items.length <= i)
        this.addItem();
      if (this._items[i]?.node) {
        if (this._items[i]?.node?.rootNodes[0].classList.contains('tombstone') && this._items[i].data) {
          if (this.animationDurationMs) {
            this._items[i].node.rootNodes[0].style.zIndex = 1;
            tombstoneAnimations[i] = [this._items[i].node, this._items[i].top - this._anchorScrollTop];
          } else {
            this._items[i].node.rootNodes[0].style.display = 'none';
            this._tombstonesRecycler.push(this._items[i].node);
          }
        } else {
          continue;
        }
      }

      if (!this.hasMore && !this._items[i].data) return;
      let node = this._items[i].data ? this.render(this._items[i].data, this._recycler.pop()) : this.getTombstone();
      node.rootNodes[0].style.position = 'absolute';
      this._items[i].top = -1;
      this._viewContainerRef.insert(node);
      this._items[i].node = node;
    }

    this._recycler = [];

    requestAnimationFrame(() => {
      for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++)
        if (this._items[i].data && !this._items[i].height) {
          this._items[i].height = this._items[i].node?.rootNodes[0].offsetHeight;
          this._items[i].width = this._items[i].node?.rootNodes[0].offsetWidth;
        }
    })

    this._anchorScrollTop = 0;
    for (let i = 0; i < this._anchorItem.index; i++)
      this._anchorScrollTop += this._items[i].height || this._tombstoneHeight;
    this._anchorScrollTop += this._anchorItem.offset;

    let currentPosition = this._anchorScrollTop - this._anchorItem.offset;
    let i = this._anchorItem.index;
    while (i > this._firstAttachedItem)
      currentPosition -= this._items[--i].height ||  this._tombstoneHeight;
    while (i < this._firstAttachedItem)
      currentPosition += this._items[i++].height || this._tombstoneHeight;

    for (let i in tombstoneAnimations) {
      let anim = tombstoneAnimations[i];
      // TODO: fix this
      this._items[i].node.rootNodes[0].style.transform = `translateY(${this._anchorScrollTop + anim[1]}px) scale(${this._tombstoneWidth / this._items[i].width}, ${this._tombstoneHeight / this._items[i].height})`;
      this._items[i].node.rootNodes[0].offsetTop;
      anim[0].offsetTop;
      // TODO: fix this
      this._items[i].node.rootNodes[0].style.transition = `transform ${this.animationDurationMs}ms`;
    }

    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      let anim = tombstoneAnimations[i];
      if (anim) {
        anim[0].rootNodes[0].style.transition = `transform ${this.animationDurationMs}ms, opacity ${this.animationDurationMs}ms`;
        anim[0].rootNodes[0].style.transform = `translateY(${currentPosition}px) scale(${this._tombstoneWidth / this._items[i].width}, ${this._tombstoneHeight / this._items[i].height})`;
        anim[0].rootNodes[0].style.opacity = 0;
      }
      if (currentPosition != this._items[i].top) {
        // TODO: fix this
        if (!anim)
          this._items[i].node.rootNodes[0].style.transition = '';
        this._items[i].node.rootNodes[0].style.transform = `translateY(${currentPosition}px)`;
      }
      this._items[i].top = currentPosition;
      currentPosition += this._items[i].height || this._tombstoneHeight;
    }

    // TODO: make this 
    this._scrollRunwayEnd = Math.max(this._scrollRunwayEnd, currentPosition + this.additionalScroll);
    this._renderer.setStyle(this._virtualList.sentinel?.nativeElement, 'transform', `translateY(${this._scrollRunwayEnd}px)`);
    // TODO: set the scroll top (declare set or method in virtual-list component)

    if (this.animationDurationMs)
      setTimeout(() => {
        for (let i in tombstoneAnimations) {
          let anim = tombstoneAnimations[i];
          anim[0].rootNodes[0].style.display = 'none';
          this._tombstonesRecycler.push(anim[0]);
        }
      }, this.animationDurationMs);

    // TODO: caluclate items needed and if it was big enough then call this
    this.maybeRequestContent();
  }

  maybeRequestContent() {
    if (this._requestInProgress) return;
    // let itemsNeeded = this._lastAttachedItem - this._loadedItems;
    // if (itemsNeeded <= 0) return;
    this._requestInProgress = true;
    this._virtualList.onScrollEnd();
  }

  getTombstone() {
    var tombstone = this._tombstonesRecycler.pop();
    if (tombstone) {
      tombstone.rootNodes[0].style.opacity = 1;
      tombstone.rootNodes[0].style.display = 'unset';
      tombstone.rootNodes[0].style.transform = '';
      tombstone.rootNodes[0].style.transition = '';
      return tombstone;
    }
    return this.createTombstone();
  }

  addItem() {
    this._items.push({
      data: null,
      node: null,
      height: 0,
      width: 0,
      top: 0,
    });
  }

  createTombstone() {
    return this.tombstone.createEmbeddedView(new VirtualListItem(null, NaN, NaN));
  }
  
  render(item: any, node: EmbeddedViewRef<VirtualListItem>) {
    if (!node)
      return this._template.createEmbeddedView(new VirtualListItem(item, item.index, item.index+1));
    node.context.$implicit = item;
    node.context.index = item.index;
    node.context.count = item.index+1;
    return node;
  }
}
