import {
  Directive,  Input,
  OnChanges, OnDestroy, OnInit, DoCheck,
  IterableChanges, IterableDiffer, SimpleChanges, IterableDiffers, NgIterable, TrackByFunction, 
  EmbeddedViewRef, TemplateRef, ViewContainerRef,
} from '@angular/core';
import { Subscription } from "rxjs";
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { Recycler } from '../models/recycler';
import { VirtualListNodeContext } from '../models/virtual-list-node-context';
import { ListItem } from "../models/virtual-list-item";

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> implements OnChanges, DoCheck, OnInit, OnDestroy {
  @Input('virtualForOf') data!: NgIterable<T>;
  @Input('virtualForTrackBy') trackBy!: TrackByFunction<T>;
  //? Still more data avilable or not
  @Input('virtualForHasMoreFn') hasMoreFn!: () => boolean;

  //? An empty placeholder for an item
  @Input('virtualForTombstone') tombstone!: TemplateRef<any>;

  //? Number of items to render before and after the visible viewport
  @Input('virtualForMarginalItemsToRender') marginalItemsToRender: number = 2;
  //? Max number of tombstones that are shown on screen
  @Input('virtualForMaxTombstonesToShow') maxTombstonesToShow: number = 3;
  //? extra amount that can be scrolled to at the bottom of scrollable area
  @Input('virtualForAdditionalScrollPx') additionalScrollPx: number = 100;

  //? Used for change detection of data
  private _differ!: IterableDiffer<T>;
  //? Items of the list
  private _items: ListItem[] = [];
  //? Is fetching data
  private _requestInProgress = false;

  private _firstAttachedItem = 0;
  private _lastAttachedItem = 0;

  private _tombstones = new Recycler();
  private _unusedNodes = new Recycler();

  //? Number of items loaded from the first
  private _loadedItems = 0;

  //? If true, we must reposition the scroll
  private _measureRequired = false;

  //? Amount of scroll
  private _scrollTop = 0;
  //? The first item index and the amount out of viewport (offset)
  private _anchor: { index: number, offset: number } = {index:0, offset: 0};
  //? Height of a tombstone used for situations we don't know the actual item height 
  private _tombstoneHeight = 0;
  //? Total scroll height
  private _scrollEnd = 0;

  private _subscription = new Subscription();

  constructor(
    //? A factory for getting an iterable differ
    private _differs: IterableDiffers,
    //? An abstract container including all of the items
    private _viewContainerRef: ViewContainerRef,
    //? The template of each item
    private _template: TemplateRef<VirtualListNodeContext>,
    //? Refrence to the virtual list component surrounding the directive to respond and emit events
    private _virtualList: VirtualListComponent
  ) {}

  ngOnInit(): void {
    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(() => {
        //? calculate the tombstone size
        if(!this._tombstoneHeight) {
          let tombstone = this.getTombstone();
          tombstone.rootNodes[0].style.position = 'absolute';
          this._viewContainerRef.insert(tombstone);
          this._tombstoneHeight = tombstone.rootNodes[0].offsetHeight;
          this._viewContainerRef.remove(this._viewContainerRef.indexOf(tombstone));
        }
        //? Scince the screen has been resized, the height of items might change so previous heights are not valid anymore
        //? so we reset them to zero
        for (let i = 0; i < this._items.length; i++)
          this._items[i].width = this._items[i].height = 0;

        //? Call on scroll to do the calculations and reattach the content
        this.onScroll();
      })
    );
    this._subscription.add(
      //? Call on scroll when we scroll
      this._virtualList.scrollPosition$.subscribe(() => this.onScroll())
    );
  }

  ngOnDestroy(): void {
    //? Clear the recycle bins and subscriptions
    this._tombstones.clean();
    this._unusedNodes.clean();
    this._subscription.unsubscribe();
  }

  //? Constructing the differ for checking the changes in data
  ngOnChanges(changes: SimpleChanges): void {
    if (!('data' in changes)) return;

    const value = changes['data'].currentValue;
    if (this._differ || !value) return;

    try {
      this._differ = this._differs.find(value).create(this.trackBy);
    } catch (exception) {
      throw new Error(`Cannot find a differ supporting object '${value}' of this type. NgFor only supports binding to Iterables such as Arrays.`);
    }
  }

  //? If differ is set and we have changes then calls applyChanges
  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
  }

  applyChanges(changes: IterableChanges<T>) {
    //? Changing the items based on the changes we got from differ
    changes.forEachOperation(({item, previousIndex}, adjustedPreviousIndex, currentIndex) => {
      if (previousIndex == null) {
        //? Insert item
        this._items.splice(currentIndex || 0, 0, {data: item, height: 0});
        this._loadedItems++;
      } else if (currentIndex == null) {
        //? Delete item
        this._items.splice(adjustedPreviousIndex || 0, 1);
        this._loadedItems--;
      } else {
        //? Adjust item position in list
        this._items.splice(currentIndex, 0, this._items.splice(adjustedPreviousIndex || 0, 1)[0]);
      }
    });
    //? Properties of an item change
    changes.forEachIdentityChange((record: any) => this._items[record.currentIndex].data = record.item);

    this._requestInProgress = false;

    //? Insert the elements into the dom
    this.attachContent();
  }

  onScroll() {
    let delta = this._virtualList.scrollTop - this._scrollTop;

    //? If data is finished and we are at bottom of the scroll, don't scroll more
    if (!this.hasMoreFn() && delta > 0 && this.calculateAnchoredItem(this._anchor, this._virtualList.measure().height).index == this._loadedItems-1) {
      this._lastAttachedItem = this._loadedItems;
      this.fill(this._anchor.index - this.marginalItemsToRender, this._lastAttachedItem);
      return;
    }

    //? Calculating the first and last items and set the new scroll
    this._anchor = this._virtualList.scrollTop == 0 ? {index: 0, offset: 0} : this.calculateAnchoredItem(this._anchor, delta);
    this._scrollTop = this._virtualList.scrollTop;
    let {index: lastIndex} = this.calculateAnchoredItem(this._anchor, this._virtualList.measure().height);
    this.fill(this._anchor.index - this.marginalItemsToRender, lastIndex + this.marginalItemsToRender);
  }

  
  calculateAnchoredItem(initialAnchor: { index: number, offset: number }, delta: number) {
    if (delta == 0)
      return initialAnchor;

    delta += initialAnchor.offset;
    let i = initialAnchor.index;
    let tombstones = 0;

    //? Scroll up
    if (delta < 0) {
      //? Add the height of upper item to delta until the delta gets zero
      while (delta < 0 && i > 0 && this._items[i - 1].height)
      delta += this._items[--i].height;
      
      tombstones = Math.max(-i, Math.ceil(Math.min(delta, 0) / this._tombstoneHeight));
    } else {
      //? Scroll Down
      //? Subtract the height of upper item from delta until the delta gets zero
      while (delta > 0 && i < this._items.length && this._items[i].height && this._items[i].height < delta)
        delta -= this._items[i++].height;

      if (i >= this._items.length || !this._items[i].height)
        tombstones = Math.floor(Math.max(delta, 0) / this._tombstoneHeight);
    }

    i += tombstones;
    delta -= tombstones * this._tombstoneHeight;

    return {
      index: i,
      offset: delta,
    };
  }

  fill(start: number, end: number) {
    this._firstAttachedItem = Math.max(0, start);
    this._lastAttachedItem = end; 
    this.attachContent();
  } 

  attachContent() {
    this.recycleUnusedNodes();
    this.insertVisibleItems();

    //? Clear the nodes in recycle bin from dom
    while(this._unusedNodes.size) {
      let index = this._viewContainerRef.indexOf(this._unusedNodes.getView() as EmbeddedViewRef<any>);
      if (index >= 0)
        this._viewContainerRef.detach(index);
    }

    //? Call requestAnimationFrame to force the browser calculate heights and set the positions before repainting the screen
    requestAnimationFrame(() => {
      this.getItemsSize();
      if (this._measureRequired)
        this.updateScroll();
  
      this.positionViews();
    });

    //? If items are needed, then fetch them
    this.maybeRequestContent();
  }

  //? Recycle the items offscreen
  recycleUnusedNodes() {
    for (let i = 0; i < this._items.length; i++) {
      //? Skip the visible items
      if (i == this._firstAttachedItem) {
        i = this._lastAttachedItem - 1;
        continue;
      }
      //? If tombstone put in tombstones recycle bin else put into nodes recycle bin
      if (this._items[i].node)
        if (this._items[i].node.rootNodes[0].classList.contains('tombstone')) {
          this._viewContainerRef.detach(this._viewContainerRef.indexOf(this._items[i].node));
          this._tombstones.recycleView(this._items[i].node);
        } else {
          this._unusedNodes.recycleView(this._items[i].node);
        }
      this._items[i].node = null;
    }
  }

  insertVisibleItems() {
    let tombstonesCount = 0;
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      //? Accurs when the items isn't enough to fill this range of items
      //? so we add empty items and display tombstones until the real data arrives
      while (this._items.length <= i)
        this.addItem();

      //? Recycle the tombstones that their corresponding item has height
      if (this._items[i].node) {
        if (!this._items[i].node.rootNodes[0].classList.contains('tombstone') || this._items[i].height) continue;

        this._viewContainerRef.detach(this._viewContainerRef.indexOf(this._items[i].node));
        this._tombstones.recycleView(this._items[i].node);
        this._items[i].node = null;
      }

      //? Render an item or tombstone
      let node = this._items[i].data ? this.render(this._items[i].data, this._unusedNodes.getView()) : this.getTombstone();
      if (node.rootNodes[0].classList.contains('tombstone')) {
        node.rootNodes[0].style.display = 'unset';
        tombstonesCount++;
        //? Prevent more tombstones to be displayed if the limit is passed
        if (tombstonesCount > this.maxTombstonesToShow)
          node.rootNodes[0].style.display = 'none';
      }
      //? Insert the node into dom and set the 'node' property of it's corresponding item
      node.rootNodes[0].style.position = 'absolute';
      this._items[i].top = -1;
      this._viewContainerRef.insert(node);
      this._items[i].node = node;
    }
  }

  //? Calculates the exact size of items visible
  getItemsSize() {
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      if (!this._items[i].data || this._items[i].height) continue;

      this._items[i].height = this._items[i].node.rootNodes[0].offsetHeight;
      this._items[i].width = this._items[i].node.rootNodes[0].offsetWidth;
      this._measureRequired = true;
    }
  }

  positionViews() {
    //? Position all nodes.
    let currentPosition = this._scrollTop - this._anchor.offset;
    let i = this._anchor.index;

    //? currentPosition will be the first attached item position after these two loops (not necessarily visible)
    //* ScrollDown
    while (i > this._firstAttachedItem)
      currentPosition -= this._items[--i].height || this._tombstoneHeight;

    //* ScrollUp
    while (i < this._firstAttachedItem)
      currentPosition += this._items[i++].height || this._tombstoneHeight;
    
    //? Set the transform of each visible item
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      if (currentPosition != this._items[i].top)
        this._items[i].node.rootNodes[0].style.transform = `translateY(${currentPosition}px)`;

      this._items[i].top = currentPosition;
      currentPosition += this._items[i].height || this._tombstoneHeight;
    }

    this._scrollEnd = Math.max(this._scrollEnd, currentPosition);
  }

  //? Update the total height of the scroll based on latest item heights
  updateScroll() {
    this._scrollTop = 0;
    for (let i = 0; i < this._anchor.index; i++)
      this._scrollTop += this._items[i].height || this._tombstoneHeight;
    this._scrollTop += this._anchor.offset;

    this._virtualList.totalScroll = this._scrollEnd+(this.hasMoreFn() ? this.additionalScrollPx : 0);
    this._measureRequired = false;
  }

  //? renders the given data in given node
  render(data: any, node: any) {
    if (!node)
      return this._template.createEmbeddedView(new VirtualListNodeContext(data, data.index, this._loadedItems));

    node.context.$implicit = data;
    node.context.index = data.index;
    node.context.count = this._loadedItems;
    return node;
  }

  //? If more items needed, then we request more
  maybeRequestContent() {
    if (this._requestInProgress) return;

    let itemsNeeded = this._lastAttachedItem - this._loadedItems;
    if (itemsNeeded <= 0) return;

    this._requestInProgress = true;
    this._virtualList.onScrollEnd();
  }

  //? Adds an empty item to the items array
  addItem() {
    this._items.push({height: 0});
  }

  //? Gets a tombstone from tombstones recycle bin or creates a new one
  getTombstone() {
    var tombstone = this._tombstones.getView() as EmbeddedViewRef<any>;
    if (!tombstone)
      return this.tombstone.createEmbeddedView({});

    tombstone.rootNodes[0].style.display = 'unset';
    tombstone.rootNodes[0].style.transform = '';
    return tombstone;
  }
}
