import { Directive, DoCheck, EmbeddedViewRef, Input, IterableChanges, IterableDiffer, IterableDiffers, NgIterable, OnChanges, OnDestroy, OnInit, Renderer2, SimpleChanges, TemplateRef, ViewContainerRef, ViewRef } from '@angular/core';
import { filter, Subscription } from 'rxjs';
import { VirtualListComponent } from '../components/virtual-list/virtual-list.component';

@Directive({
  selector: '[virtualForConstantHeight][virtualForConstantHeightOf]'
})
export class VirtualForConstantHeightDirective<T> implements OnInit, OnChanges, DoCheck, OnDestroy {
  @Input('virtualForConstantHeightOf') data!: NgIterable<T>;
  @Input('virtualForConstantHeightRowHeight') rowHeight!: number;

  private _subscription = new Subscription();
  private _scrollY = -1;
  private _isInMeasure = false;
  private _isInLayout = false;
  private _differ!: IterableDiffer<T>;
  // TODO: find a better name for this
  private _collection: any[] = [];
  private _pendingMeasurement!: number;
  private _startIndex: number = 0;
  private _endIndex: number = 0;
  private _offset = 0;

  constructor(
    private virtualList: VirtualListComponent,
    private viewContainerRef: ViewContainerRef,
    private templateRef: TemplateRef<any>,
    private _differs: IterableDiffers,
    private _renderer: Renderer2,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (!('data' in changes)) return;

    const value = changes['data'].currentValue;

    if (this._differ && value) return;

    this._differ = this._differs.find(value).create();
  }

  ngOnInit(): void {
    this._subscription.add(
      this.virtualList.scrollPosition$.pipe(
        filter(scrollY => Math.abs(scrollY - this._scrollY) >= this.rowHeight)
      ).subscribe(scrollY => {
        this._scrollY = scrollY;
        this.requestLayout();
      })
    );
  }

  ngDoCheck(): void {
    if (!this._differ) return;
    const changes = this._differ.diff(this.data);

    if (changes) this.applyChanges(changes);
  }

  ngOnDestroy(): void {
    this._subscription.unsubscribe();
  }

  private applyChanges(changes: IterableChanges<T>) {
    changes.forEachAddedItem(itemRecord => this._collection.push(itemRecord.item));

    this.requestMeasure();
  }

  private requestMeasure() {
    if (this._isInMeasure || this._isInLayout) {
      clearTimeout(this._pendingMeasurement);
      this._pendingMeasurement = window.setTimeout(this.requestMeasure, 60);
      return;
    }

    this.measure();
  }

  private measure() {
    this._isInMeasure = true;
    this._isInMeasure = false;
    // (this.virtualList.sentinel as EmbeddedViewRef<any>).rootNodes[0].style.transform = `translateY(${this.rowHeight * this._collection.length})`
    this.requestLayout();
  }

  private requestLayout() {
    if (!this._isInMeasure && this.rowHeight)
      this.constructLayout();
  }

  private constructLayout() {
    if (this._isInLayout) return;

    this._isInLayout = true;
    this.getVisibleRange();
    for (let i = 0; i < this.viewContainerRef.length; i++) {
      let view = this.viewContainerRef.get(i) as EmbeddedViewRef<any>;
      view.detach();
    }
    for (let i = this._startIndex; i < this._endIndex; i++) {
      let view = this.viewContainerRef.createEmbeddedView(this.templateRef) as EmbeddedViewRef<any>;
      view.context.$implicit = this._collection[i];
      this.viewContainerRef.insert(view);
      view.reattach();
    }
    this._isInLayout = false;
  }

  private getVisibleRange() {
    this._startIndex = Math.ceil(this._scrollY / this.rowHeight);
    this._offset = this._scrollY % this.rowHeight;
    this._endIndex = Math.ceil((this._scrollY + this.virtualList.height) / this.rowHeight);

  }
}
