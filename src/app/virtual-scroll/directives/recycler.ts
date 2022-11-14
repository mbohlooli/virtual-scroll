import { ViewRef } from "@angular/core";

/**
 * A recycle bin for recycling elements out of screen
 */
export class Recycler {
  // The maximum number of elements that recycler can hold
  private limit: number = 5;
  // The recycled elements
  private _scrapViews: Map<number, ViewRef> = new Map();

  // get a view from recycle bin if possible
  getView(position: number): ViewRef | null {
    let view = this._scrapViews.get(position);

    if (!view && this._scrapViews.size > 0) {
      position = this._scrapViews.keys().next().value;
      view = this._scrapViews.get(position);
    }

    if (view)
      this._scrapViews.delete(position);

    return view || null;
  }

  // put a view in recycle bin
  recycleView(position: number, view: ViewRef) {
    view.detach();
    this._scrapViews.set(position, view);
  }

  // Empty extra items from recycler
  pruneScrapViews() {
    if (this.limit <= 1)
      return;

    let keyIterator = this._scrapViews.keys();
    let key: number;

    while (this._scrapViews.size > this.limit) {
      key = keyIterator.next().value;
      this._scrapViews.get(key)?.destroy();
      this._scrapViews.delete(key);
    }
  }

  // Set the recycler maximum limit
  setScrapViewsLimit(limit: number) {
    this.limit = limit;
    this.pruneScrapViews();
  }

  // Deltete all items from recycler
  clean() {
    this._scrapViews.forEach((view: ViewRef) => view.destroy());
    this._scrapViews.clear();
  }
}
