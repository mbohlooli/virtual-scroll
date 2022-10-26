import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VirtualListComponent } from './components/virtual-list/virtual-list.component';
import { VirtualForDirective } from './directives/virtual-for.directive';
import { VirtualForConstantHeightDirective } from './directives/virtual-for-constant-height.directive';



@NgModule({
  declarations: [
    VirtualListComponent,
    VirtualForDirective,
    VirtualForConstantHeightDirective
  ],
  exports: [
    VirtualListComponent,
    VirtualForDirective
  ],
  imports: [
    CommonModule
  ]
})
export class VirtualScrollModule { }
