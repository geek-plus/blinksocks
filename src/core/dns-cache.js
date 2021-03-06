import dns from 'dns';
import net from 'net';

export const DNS_SURVIVAL_TIME = 3600000;

export class DNSCache {

  _pool = {};

  static create() {
    return new DNSCache();
  }

  _now() {
    return (new Date()).getTime();
  }

  _lookup(hostname) {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, function (err, address) {
        if (err) {
          reject(err);
        } else {
          resolve(address);
        }
      });
    });
  }

  _put(hostname, address) {
    const expire = this._now() + DNS_SURVIVAL_TIME;
    this._pool[hostname] = [address, expire];
  }

  async get(hostname) {
    if (net.isIP(hostname)) {
      return hostname;
    }
    let address = null;
    if (typeof this._pool[hostname] === 'undefined') {
      address = await this._lookup(hostname);
      this._put(hostname, address);
    } else {
      const [addr, expire] = this._pool[hostname];
      if (this._now() >= expire) {
        delete this._pool[hostname];
      }
      address = addr;
    }
    return address;
  }

}
