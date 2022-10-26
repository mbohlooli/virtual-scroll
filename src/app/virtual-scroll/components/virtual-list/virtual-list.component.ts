import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
import { filter, fromEvent, map, Subscription } from 'rxjs';

@Component({
  selector: 'virtual-list',
  templateUrl: './virtual-list.component.html',
  styleUrls: ['./virtual-list.component.scss']
})
export class VirtualListComponent implements AfterViewInit {
  @ViewChild('listContainer') private _listContainer!: ElementRef;

  private _subscription = new Subscription();
  private _ignoreScrollEvent = false;

  constructor() { }

  ngAfterViewInit(): void {
    this._subscription.add(fromEvent(this._listContainer.nativeElement, 'scroll').pipe(
      filter(() => {
        if (this._ignoreScrollEvent) {
          this._ignoreScrollEvent = false;
          return false;
        }
        return true;
      }),
      map(() => this._listContainer.nativeElement.scrollTop)
    ).subscribe(console.log));
  }

}
