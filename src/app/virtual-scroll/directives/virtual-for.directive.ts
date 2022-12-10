import {
  Directive,  Input,
  OnChanges, OnDestroy, OnInit, DoCheck,
  IterableChanges, IterableDiffer, SimpleChanges, IterableDiffers, NgIterable, TrackByFunction, 
  EmbeddedViewRef, TemplateRef, ViewContainerRef,
} from '@angular/core';
import { Subscription } from "rxjs";
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';
import { Recycler } from '../recycler';
import { VirtualListItem } from '../virtual-list-item';

interface ListItem {
  data?: any,
  node?: any,
  height: number,
  width?: number,
  top?: number
}

interface ScrollAnchor {
  index: number,
  offset: number
}

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> implements OnChanges, DoCheck, OnInit, OnDestroy {
  @Input('virtualForOf') data!: NgIterable<T>;
  @Input('virtualForTrackBy') trackBy!: TrackByFunction<T>;
  @Input('virtualForHasMoreFn') hasMoreFn!: () => boolean;

  @Input('virtualForTombstone') tombstone!: TemplateRef<any>;

  @Input('virtualForMarginalItemsToRender') marginalItemsToRender: number = 2;
  @Input('virtualForMaxTombstonesToShow') maxTombstonesToShow: number = 3;

  private _differ!: IterableDiffer<T>;
  private _items: ListItem[] = [];
  private _requestInProgress = false;

  private _firstAttachedItem = 0;
  private _lastAttachedItem = 0;

  private _tombstones = new Recycler();
  private _unusedNodes = new Recycler();

  private _loadedItems = 0;

  private _measureRequired = false;

  private _scrollTop = 0;
  private _anchor: ScrollAnchor = {index:0, offset: 0};

  private _tombstoneHeight = 0;
  private _tombstoneWidth = 0;
  
  private _scrollEnd = 0;
  private _subscription = new Subscription();

  constructor(
    private _differs: IterableDiffers,
    private _viewContainerRef: ViewContainerRef,
    private _template: TemplateRef<VirtualListItem>,
    private _virtualList: VirtualListComponent
  ) {}

  ngOnInit(): void {
    this._subscription.add(
      this._virtualList.sizeChange$.subscribe(() => {
        let tombstone = this.getTombstone();
        //? nesseary??
        tombstone.rootNodes[0].style.position = 'absolute';
        this._viewContainerRef.insert(tombstone);
        this._tombstoneHeight = tombstone.rootNodes[0].offsetHeight;
        this._tombstoneWidth = tombstone.rootNodes[0].offsetWidth;
        this._viewContainerRef.remove(this._viewContainerRef.indexOf(tombstone));
        
        for (let i = 0; i < this._items.length; i++)
          this._items[i].width = this._items[i].height = 0;
        this.onScroll();
      })
    );
    this._subscription.add(
      this._virtualList.scrollPosition$.subscribe(() => this.onScroll())
    );
  }

  ngOnDestroy(): void {
    this._tombstones.clean();
    this._unusedNodes.clean();
    this._subscription.unsubscribe();
  }

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

  ngDoCheck(): void {
    if (!this._differ) return;

    const changes = this._differ.diff(this.data);
    if (!changes) return;

    this.applyChanges(changes);
  }

  applyChanges(changes: IterableChanges<T>) {
    changes.forEachOperation(({item, previousIndex}, adjustedPreviousIndex, currentIndex) => {
      if (previousIndex == null) {
        this._items.splice(currentIndex || 0, 0, {data: item, height: 0});
        this._loadedItems++;
      } else if (currentIndex == null) {
        this._items.splice(adjustedPreviousIndex || 0, 1);
        this._loadedItems--;
      } else {
        this._items.splice(currentIndex, 0, this._items.splice(adjustedPreviousIndex || 0, 1)[0]);
      }
    });
    changes.forEachIdentityChange((record: any) => this._items[record.currentIndex].data = record.item);

    this._requestInProgress = false;

    this.attachContent();
  }

  onScroll() {
    let delta = this._virtualList.scrollTop - this._scrollTop;

    if (!this.hasMoreFn() && delta > 0 && this.calculateAnchoredItem(this._anchor, this._virtualList.measure().height).index == this._loadedItems-1) {
      this._lastAttachedItem = this._loadedItems;
      this.fill(this._anchor.index - this.marginalItemsToRender, this._lastAttachedItem);
      return;
    }

    this._anchor = this._virtualList.scrollTop == 0 ? {index: 0, offset: 0} : this.calculateAnchoredItem(this._anchor, delta);
    this._scrollTop = this._virtualList.scrollTop;
    let {index: lastIndex} = this.calculateAnchoredItem(this._anchor, this._virtualList.measure().height);
    this.fill(this._anchor.index - this.marginalItemsToRender, lastIndex + this.marginalItemsToRender);
  }

  
  calculateAnchoredItem(initialAnchor: ScrollAnchor, delta: number) {
    if (delta == 0)
      return initialAnchor;

    delta += initialAnchor.offset;
    let i = initialAnchor.index;
    let tombstones = 0;

    if (delta < 0) {
      while (delta < 0 && i > 0 && this._items[i - 1].height)
        delta += this._items[--i].height;

      tombstones = Math.max(-i, Math.ceil(Math.min(delta, 0) / this._tombstoneHeight));
    } else {
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
    //TODO: display tombstone until the item height becomes known
    this.recycleUnusedNodes();
    this.insertVisibleItems();

    while(this._unusedNodes.size) {
      let index = this._viewContainerRef.indexOf(this._unusedNodes.getView() as EmbeddedViewRef<any>);
      if (index >= 0)
        this._viewContainerRef.detach(index);
    }

    requestAnimationFrame(() => {
      this.getItemsSize();
      if (this._measureRequired)
        this.updateScroll();
  
      this.positionViews();
    });


    this.maybeRequestContent();
  }

  recycleUnusedNodes() {
    for (let i = 0; i < this._items.length; i++) {
      if (i == this._firstAttachedItem) {
        i = this._lastAttachedItem - 1;
        continue;
      }
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
      while (this._items.length <= i)
        this.addItem();

      if (this._items[i].node) {
        if (!this._items[i].node.rootNodes[0].classList.contains('tombstone') || this._items[i].height) continue;

        this._viewContainerRef.detach(this._viewContainerRef.indexOf(this._items[i].node));
        this._tombstones.recycleView(this._items[i].node);
        this._items[i].node = null;
      }

      let node = this._items[i].data ? this.render(this._items[i].data, this._unusedNodes.getView()) : this.getTombstone();
      if (node.rootNodes[0].classList.contains('tombstone')) {
        node.rootNodes[0].style.display = 'unset';
        tombstonesCount++;
        if (tombstonesCount > this.maxTombstonesToShow)
          node.rootNodes[0].style.display = 'none';
      }
      node.rootNodes[0].style.position = 'absolute';
      this._items[i].top = -1;
      this._viewContainerRef.insert(node);
      this._items[i].node = node;
    }
  }

  async getItemsSize() {
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      if (!this._items[i].data || this._items[i].height) continue;

      this._items[i].height = this._items[i].node.rootNodes[0].offsetHeight;
      this._items[i].width = this._items[i].node.rootNodes[0].offsetWidth;
      this._measureRequired = true;
    }
  }

  positionViews() {
    // Position all nodes.
    let currentPosition = this._scrollTop - this._anchor.offset;
    let i = this._anchor.index;

    //? curPos will be the first attached item position after these two loops (not necessarily visible)
    //* ScrollDown
    while (i > this._firstAttachedItem)
      currentPosition -= this._items[--i].height || this._tombstoneHeight;

    //* ScrollUp
    while (i < this._firstAttachedItem)
      currentPosition += this._items[i++].height || this._tombstoneHeight;
    
    for (let i = this._firstAttachedItem; i < this._lastAttachedItem; i++) {
      if (currentPosition != this._items[i].top)
        this._items[i].node.rootNodes[0].style.transform = `translateY(${currentPosition}px)`;

      this._items[i].top = currentPosition;
      currentPosition += this._items[i].height || this._tombstoneHeight;
    }

    this._scrollEnd = Math.max(this._scrollEnd, currentPosition);
  }

  updateScroll() {
    this._scrollTop = 0;
    for (let i = 0; i < this._anchor.index; i++)
      this._scrollTop += this._items[i].height || this._tombstoneHeight;
    this._scrollTop += this._anchor.offset;

    this._virtualList.totalScroll = this._scrollEnd+(this.hasMoreFn() ? 100 : 0);
    this._virtualList.scrollTop = this._scrollTop;
    this._measureRequired = false;
  }

  render(item: any, node: any) {
    if (!node)
      return this._template.createEmbeddedView(new VirtualListItem(item, item.index, this._loadedItems));

    node.context.$implicit = item;
    node.context.index = item.index;
    node.context.count = this._loadedItems;
    return node;
  }

  maybeRequestContent() {
    if (this._requestInProgress) return;

    let itemsNeeded = this._lastAttachedItem - this._loadedItems;
    if (itemsNeeded <= 0) return;

    this._requestInProgress = true;
    this._virtualList.onScrollEnd();
  }

  addItem() {
    this._items.push({height: 0});
  }

  getTombstone() {
    var tombstone = this._tombstones.getView() as EmbeddedViewRef<any>;
    if (!tombstone)
      return this.tombstone.createEmbeddedView({});

    tombstone.rootNodes[0].style.display = 'unset';
    tombstone.rootNodes[0].style.transform = '';
    return tombstone;
  }
}
