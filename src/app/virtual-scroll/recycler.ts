import { ViewRef } from "@angular/core";

/**
 * A recycle bin for recycling elements out of screen
 */
export class Recycler {
  // The maximum number of elements that recycler can hold
  private limit: number = 10;
  // The recycled elements
  private _scrapViews: ViewRef[] = [];

  get size(): number {
    return this._scrapViews.length;
  }

  // get a view from recycle bin if possible
  getView(): ViewRef | null {
    let position = 0;
    let view = this._scrapViews[position];

    if (!view && this._scrapViews.length > 0)
      view = this._scrapViews[++position];

    if (view)
      this._scrapViews.splice(position, 1);

    return view || null;
  }

  // put a view in recycle bin
  recycleView(view: ViewRef) {
    view.detach();
    this._scrapViews.push(view);
  }

  // Empty extra items from recycler
  pruneScrapViews() {
    if (this.limit <= 1)
      return;

    if (this._scrapViews.length > this.limit)
      this._scrapViews = this._scrapViews.slice(0, this.limit);
  }

  // Set the recycler maximum limit
  setScrapViewsLimit(limit: number) {
    this.limit = limit;
    this.pruneScrapViews();
  }

  // Deltete all items from recycler
  clean() {
    this._scrapViews.forEach((view: ViewRef) => view.destroy());
    this._scrapViews = [];
  }
}
