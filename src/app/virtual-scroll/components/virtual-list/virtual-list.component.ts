import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild
} from '@angular/core';
import { BehaviorSubject, fromEvent, Subscription } from 'rxjs';
import { debounceTime, map, tap } from "rxjs/operators";
import { ScrollState } from '../../scroll-state';

/**
 * Wrapper for a virtual list
 * used with virtualForConstantHeight or virtualFor directives
 * pass the required info and elements of dom to the directive
 */
@Component({
  selector: 'virtual-list',
  templateUrl: './virtual-list.component.html',
  styleUrls: ['./virtual-list.component.scss']
})
export class VirtualListComponent implements AfterViewInit, OnDestroy {
  // The viewport for list (default: window) 
  @Input('viewport') private viewport!: ElementRef;
  // Raised when user scrolls to the end of list
  @Output('scrollEnd') private scrollEnd = new EventEmitter();
  // The runway containing list items
  @ViewChild('listHolder', { static: true }) private _listHolder!: ElementRef;
  // A tiny div that moves along Y axis, simulating the total scroll height
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

  // Subjects that observe events that are important
  private _subscription = new Subscription();
  private _scrollPositionSubject = new BehaviorSubject<number>(-1);
  private _sizeChangeSubject = new BehaviorSubject<number[]>([0, 0]);
  private _scrollStateChangeSubject = new BehaviorSubject<ScrollState>(ScrollState.Idle);

  // The dimensions of viewport
  private _containerWidth!: number;
  private _containerHeight!: number;
  // Used for when the scroll doesn't stat from zero (ex. when we have a top menu bar and we use window as the scroll source)
  private _scrollOffset: number = 0;
  private _currentScrollState: ScrollState = ScrollState.Idle;

  // Listening to scroll events and size changes
  ngAfterViewInit(): void {
    this._subscription.add(
      fromEvent(this.viewport ? this.viewport.nativeElement : window, 'scroll').pipe(
        // Calculating the offset from top and mapping scroll to the correct scroll amount
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
        // Notifies the observer 200ms after the client stopped scrolling 
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

  // get the viewport dimensions
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
