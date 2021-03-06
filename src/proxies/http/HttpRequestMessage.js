import {Message} from '../common';

// +----------------------------------------+
// |  CONNECT www.bing.com:443 HTTP/1.1\r\n |
// |  Host: www.bing.com\r\n                |
// |  [...Headers]                          |
// |  \r\n                                  |
// |  \r\n                                  |
// +----------------------------------------+
export class HttpRequestMessage extends Message {

  METHOD;

  URI;

  VERSION;

  HOST;

  constructor(options = {}) {
    super();
    const fields = {
      ...options
    };
    this.METHOD = fields.METHOD;
    this.URI = fields.URI;
    this.VERSION = fields.VERSION;
    this.HOST = fields.HOST;
  }

  static parse(buffer) {
    if (buffer.length < 20) {
      return null;
    }
    const str = buffer.toString();
    const lines = str.split('\r\n');

    if (lines.length < 4) {
      return null;
    }

    const [method, uri, version] = lines[0].split(' ');
    const methods = [
      'OPTIONS', 'GET', 'HEAD', 'POST',
      'PUT', 'DELETE', 'TRACE', 'CONNECT'
    ];
    if (methods.includes(method)) {
      const headers = lines.slice(1, -2);
      for (const header of headers) {
        if (header.startsWith('Host: ')) {
          const host = header.split(' ')[1];
          return new HttpRequestMessage({
            METHOD: Buffer.from(method),
            URI: Buffer.from(uri),
            VERSION: Buffer.from(version),
            HOST: Buffer.from(host)
          });
        }
      }
    }
    return null;
  }

}
