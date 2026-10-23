import { HttpClient } from '@angular/common/http';

export class AngularPage {
  constructor(private http: HttpClient) {}
  refresh() { return this.http.get('/v1/angular', { params: { page: 1 } }); }
  save() { return this.http.post('/v1/angular', { name: 'example' }); }
}
