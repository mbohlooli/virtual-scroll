import { Directive } from '@angular/core';

function sum(arr: number[]) {
  let result = 0;
  for (let i = 0; i < arr.length; i++)
    result += arr[i];
  return result;
}

@Directive({
  selector: '[virtualFor][virtualForOf]'
})
export class VirtualForDirective<T> {

}
