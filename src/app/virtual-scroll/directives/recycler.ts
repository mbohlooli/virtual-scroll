import { ViewRef } from "@angular/core";

export class Recycler {
  private limit: number = 0;
  private _scrapViews: Map<number, ViewRef> = new Map();

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

  recycleView(position: number, view: ViewRef) {
    view.detach();
    this._scrapViews.set(position, view);
  }

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

  setScrapViewsLimit(limit: number) {
    this.limit = limit;
    this.pruneScrapViews();
  }

  clean() {
    this._scrapViews.forEach((view: ViewRef) => view.destroy());
    this._scrapViews.clear();
  }
}
