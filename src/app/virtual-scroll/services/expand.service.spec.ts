import { TestBed } from '@angular/core/testing';

import { ExpandService } from './expand.service';

describe('ExpandServiceService', () => {
  let service: ExpandService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ExpandService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
