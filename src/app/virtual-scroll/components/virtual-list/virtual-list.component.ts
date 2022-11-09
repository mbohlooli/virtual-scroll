import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild } from '@angular/core';
import { BehaviorSubject, fromEvent, Subscription } from 'rxjs';
import { map, filter, tap, debounceTime } from "rxjs/operators";
import { ScrollState } from '../../scroll-state';

@Component({
  selector: 'virtual-list',
  templateUrl: './virtual-list.component.html',
  styleUrls: ['./virtual-list.component.scss']
})
export class VirtualListComponent implements AfterViewInit, OnDestroy {
  @Input('viewport') private viewport!: ElementRef;

  @Output('scrollEnd') private scrollEnd = new EventEmitter();

  @ViewChild('listHolder', { static: true }) private _listHolder!: ElementRef;
  @ViewChild('sentinel') private _sentinel!: ElementRef;

  get listHolder(): ElementRef {
    return this._listHolder;
  }

  get sentinel(): ElementRef {
    return this._sentinel;
  }

  get scrollPosition$() {
    return this._scrollPositionSubject.asObservable();
  }

  get sizeChange$() {
    return this._sizeChangeSubject.asObservable();
  }

  get scrollStateChange$() {
    return this._scrollStateChangeSubject.asObservable();
  }

  get height(): number {
    return window.innerHeight;
  }

  private _subscription = new Subscription();
  private _scrollPositionSubject = new BehaviorSubject<number>(-1);
  private _sizeChangeSubject = new BehaviorSubject<number[]>([0, 0]);
  private _scrollStateChangeSubject = new BehaviorSubject<ScrollState>(ScrollState.Idle);

  private _ignoreScrollEvent = false;
  private _containerWidth!: number;
  private _containerHeight!: number;
  private _scrollOffset: number = 0;
  private _currentScrollState: ScrollState = ScrollState.Idle;

  ngAfterViewInit(): void {
    this._subscription.add(
      fromEvent(this.viewport ? this.viewport.nativeElement : window, 'scroll').pipe(
        filter(() => {
          if (this._ignoreScrollEvent) {
            this._ignoreScrollEvent = false;
            return false;
          }
          return true;
        }),
        map(() => {
          if (this._scrollOffset == 0 && !this.viewport) {
            let rect = this.listHolder.nativeElement.getBoundingClientRect();
            this._scrollOffset = rect.top;
          }

          return (this.viewport ? this.viewport.nativeElement.scrollTop : window.scrollY - this._scrollOffset);
        })
      ).subscribe(scrollPositon => this._scrollPositionSubject.next(scrollPositon))
    );

    if (window)
      this._subscription.add(
        fromEvent(window, 'resize')
          .subscribe(() => this.requestMeasure())
      );

    this._subscription.add(
      this._scrollPositionSubject.pipe(
        tap(() => {
          if (this._currentScrollState !== ScrollState.Idle) return;
          this._currentScrollState = ScrollState.Scrolling;
          this._scrollStateChangeSubject.next(this._currentScrollState);
        }),
        debounceTime(200),
      ).subscribe(() => {
        if (this._currentScrollState !== ScrollState.Scrolling) return;
        this._currentScrollState = ScrollState.Idle;
        this._scrollStateChangeSubject.next(this._currentScrollState);
      })
    );

    setTimeout(() => this.requestMeasure());
  }

  ngOnDestroy(): void {
    this._subscription.unsubscribe();
  }

  onScrollEnd() {
    this.scrollEnd.emit();
  }

  measure(): { width: number, height: number } {
    if (this.viewport) {
      let rect = this.viewport.nativeElement.getBoundingClientRect();
      this._containerWidth = rect.width;
      this._containerHeight = rect.height;
    } else {
      this._containerWidth = window.innerWidth;
      this._containerHeight = window.innerHeight;
    }

    return { width: this._containerWidth, height: this._containerHeight };
  }


  requestMeasure() {
    let { width, height } = this.measure();
    this._sizeChangeSubject.next([width, height]);
  }
}
