import { Component, OnInit } from '@angular/core';
import { ExpandService } from './virtual-scroll/services/expand.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  data: { index: number, text: string, image: string }[] = [];

  images: string[] = [
    '../assets/images/image0.jpg',
    '../assets/images/image1.jpg',
    '../assets/images/image2.jpg',
    '../assets/images/image3.jpg',
    '../assets/images/image4.jpg',
    '../assets/images/image5.jpg',
    '../assets/images/image6.jpg',
    '../assets/images/image7.jpg',
    '../assets/images/image8.jpg',
    '../assets/images/image9.jpg',
    '../assets/images/image10.jpg',
    '../assets/images/image11.jpg',
    '../assets/images/image12.jpg',
    '../assets/images/image13.jpg',
    '../assets/images/image14.jpg',
    '../assets/images/image15.jpg',
    '../assets/images/image16.jpg',
    '../assets/images/image17.jpg',
    '../assets/images/image18.jpg',
    '../assets/images/image19.jpg',
    '../assets/images/image20.jpg',
    '../assets/images/image21.jpg',
    '../assets/images/image22.jpg',
    '../assets/images/image23.jpg',
    '../assets/images/image24.jpg',
    '../assets/images/image25.jpg',
    '../assets/images/image26.jpg',
    '../assets/images/image27.jpg',
    '../assets/images/image28.jpg',
    '../assets/images/image29.jpg',
    '../assets/images/image31.jpg',
    '../assets/images/image32.jpg',
    '../assets/images/image33.jpg',
    '../assets/images/image34.jpg',
    '../assets/images/image35.jpg',
    '../assets/images/image36.jpg',
    '../assets/images/image37.jpg',
    '../assets/images/image38.jpg',
    '../assets/images/image39.jpg',
    '../assets/images/image40.jpg',
  ];

  loading = true;
  hasSentRequest = false;

  get randomImage() {
    return this.images[Math.floor(Math.random() * this.images.length)]
  }

  constructor(private _expantionService: ExpandService) {}

  ngOnInit(): void {
    setTimeout(() => {
      for (let i = 0; i < 50; i++)
        this.data.push({
          index: i,
          text: this.generateRandomText(),
          image: Math.random() > 0.8 ? this.randomImage : '',
        });
      this.loading = false;
      this.hasSentRequest = true;
    }, 500);
  }

  generateRandomText() {
    const CHARACTERS = 'ABCDEFGIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let length = Math.round(Math.random() * 300 + 50);

    let result = '';
    for (let i = 0; i < length; i++)
      result += CHARACTERS.charAt(Math.floor(Math.random() * CHARACTERS.length));

    return result;
  }

  scrollEnd() {
    if (!this.hasSentRequest) return;
    if (this.data.length >= 100) return;
    this.loading = true;
    setTimeout(() => {
      for (let i = 0; i < 10; i++)
        this.data.push({
          index: i,
          text: this.generateRandomText(),
          image: Math.random() > 0.8 ? this.randomImage : '',
        });
      this.loading = false;
      }, 500);
  }

  hasMore = () => {
    return this.data.length < 100;
  }

  getHeight = (item: { index: number, text: string, image: string }) => {
    if (item.image)
      return 400;

    return 100;
  }

  removeItem(index: number) {
    this.data.splice(index, 1);
  }

  changeText(index: number) {
    this.data[index].text = 'this is the awesome new text.';
  }

  expand(index: number, expanded: boolean) {
    expanded = !expanded;
    this._expantionService.expand(index);
  }

  addTop() {
    setTimeout(() => {

      this.loading = false;
      this.data.splice(0, 0, {
        index: 0,
        text: this.generateRandomText(),
        image: Math.random() > 0.8 ? this.randomImage : '',
      });
      }, 500);
  }
}
