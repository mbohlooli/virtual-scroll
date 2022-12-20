import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';


@Injectable({
  providedIn: 'root'
})
export class ExpandService {
  
  get expantion$() {
    return this._expantionSubject.asObservable();
  }

  private _expantionSubject = new BehaviorSubject(0);

  expand(index: number) {
    this._expantionSubject.next(index);
  }
}
