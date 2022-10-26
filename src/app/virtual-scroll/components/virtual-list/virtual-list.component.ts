import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, ViewRef } from '@angular/core';
import { BehaviorSubject, filter, fromEvent, map, Subscription } from 'rxjs';

@Component({
  selector: 'virtual-list',
  templateUrl: './virtual-list.component.html',
  styleUrls: ['./virtual-list.component.scss']
})
export class VirtualListComponent implements AfterViewInit, OnDestroy {
  @ViewChild('listContainer') private _listContainer!: ElementRef;
  @ViewChild('sentinel') private _sentinel!: ElementRef;

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
  private _ignoreScrollEvent = false;
  private _scrollPositionSubject = new BehaviorSubject(-1);

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
}
