import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, ViewRef } from '@angular/core';
import { BehaviorSubject, filter, fromEvent, map, Subscription } from 'rxjs';

@Component({
  selector: 'virtual-list',
  templateUrl: './virtual-list.component.html',
  styleUrls: ['./virtual-list.component.scss']
})
export class VirtualListComponent implements AfterViewInit, OnDestroy {
  @ViewChild('listContainer') private _listContainer!: ElementRef;
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

  get height(): number {
    return window.innerHeight;
    // const rect = this._listContainer.nativeElement.getBoundingClientRect();
    // return rect.height;
  }

  private _subscription = new Subscription();
  private _scrollPositionSubject = new BehaviorSubject(-1);

  private _ignoreScrollEvent = false;
  private _containerWidth!: number;
  private _containerHeight!: number;

  ngAfterViewInit(): void {
    this._subscription.add(
      fromEvent(this._listContainer.nativeElement, 'scroll').pipe(
        filter(() => {
          if (this._ignoreScrollEvent) {
            this._ignoreScrollEvent = false;
            return false;
          }
          return true;
        }),
        map(() => this._listContainer.nativeElement.scrollTop)
      ).subscribe(scrollPositon => this._scrollPositionSubject.next(scrollPositon))
    );
  }

  ngOnDestroy(): void {
    this._subscription.unsubscribe();
  }


  measure(): { width: number, height: number } {
    if (!this._listContainer || !this._listContainer.nativeElement) return { width: 0, height: 0 };

    let rect = this._listContainer.nativeElement.getBoundingClientRect();
    this._containerWidth = rect.width;
    this._containerHeight = rect.height;
    return { width: this._containerWidth, height: this._containerHeight };
  }

}
