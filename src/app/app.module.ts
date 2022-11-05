import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppComponent } from './app.component';
import { VirtualScrollModule } from './virtual-scroll/virtual-scroll.module';

@NgModule({
  declarations: [
    AppComponent,
  ],
  imports: [
    BrowserModule,
    VirtualScrollModule
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
