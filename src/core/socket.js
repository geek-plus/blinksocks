import dgram from 'dgram';
import net from 'net';
import ip from 'ip';
import isEqual from 'lodash.isequal';
import {getRandomInt} from '../utils';
import logger from './logger';
import {Config} from './config';
import {ClientProxy} from './client-proxy';
import {DNSCache} from './dns-cache';
import {Balancer} from './balancer';
import {Processor} from './processor';
import {Profile} from './profile';
import {
  MIDDLEWARE_DIRECTION_UPWARD,
  MIDDLEWARE_DIRECTION_DOWNWARD
} from './middleware';

import {ATYP_DOMAIN} from '../proxies/common';
import {UdpRequestMessage} from '../proxies/socks5';

const dnsCache = DNSCache.create();

const TRACK_CHAR_UPLOAD = '↑';
const TRACK_CHAR_DOWNLOAD = '↓';
const TRACK_MAX_SIZE = 40;
const MAX_BUFFERED_SIZE = 1024 * 1024; // 1MB

let lastServer = null;

export class Socket {

  _onClose = null;

  // when socks/http connection established on client side
  // when client tcp connection established on server side
  _isHandshakeDone = false;

  _remote = null;

  _bsocket = null;

  _fsocket = null;

  _processor = null;

  _isRedirect = false; // server only

  _proxy = null; // client only

  // +---+-----------------------+---+
  // | C | d <--> u     u <--> d | S |
  // +---+-----------------------+---+
  _tracks = []; // [`target`, 'u', '20', 'u', '20', 'd', '10', ...]

  constructor({socket, onClose}) {
    this.onForward = this.onForward.bind(this);
    this.onBackward = this.onBackward.bind(this);
    this.onError = this.onError.bind(this);
    this.onBackwardSocketDrain = this.onBackwardSocketDrain.bind(this);
    this.onBackwardSocketTimeout = this.onBackwardSocketTimeout.bind(this);
    this.onBackwardSocketClose = this.onBackwardSocketClose.bind(this);
    this.onForwardSocketDrain = this.onForwardSocketDrain.bind(this);
    this.onForwardSocketTimeout = this.onForwardSocketTimeout.bind(this);
    this.onForwardSocketClose = this.onForwardSocketClose.bind(this);

    this._onClose = onClose;
    this._remote = socket.address();
    this._bsocket = socket;
    this._bsocket.on('error', this.onError);
    this._bsocket.on('close', this.onBackwardSocketClose);

    // _bsocket is always tcp on client side
    if (__IS_CLIENT__ || __IS_TCP__) {
      this._bsocket.on('timeout', this.onBackwardSocketTimeout);
      this._bsocket.on('data', this.onForward);
      this._bsocket.on('drain', this.onBackwardSocketDrain);
      this._bsocket.setTimeout(__TIMEOUT__ * 1e3);
    }

    // udp only
    if (__IS_SERVER__ && __IS_UDP__) {
      this._bsocket.on('message', (buffer, rinfo) => {
        // Note: implement socket.write for udp socket here.
        this._bsocket.write = (buffer) => this._bsocket.send(buffer, rinfo.port, rinfo.address);
        this.onForward(buffer);
      });
    }

    if (__IS_SERVER__) {
      this._tracks.push(this.remote);
      this._processor = this.createProcessor();
    }

    if (__IS_CLIENT__) {
      this._proxy = new ClientProxy({
        onHandshakeDone: this.onHandshakeDone.bind(this)
      });
    }
  }

  // getters

  get remote() {
    const {address, port} = this._remote;
    return `${address}:${port}`;
  }

  get fsocketWritable() {
    if (__IS_UDP__) {
      return true;
    } else {
      return this._fsocket !== null && !this._fsocket.destroyed && this._fsocket.writable;
    }
  }

  get bsocketWritable() {
    if (__IS_UDP__) {
      return true;
    } else {
      return this._bsocket !== null && !this._bsocket.destroyed && this._bsocket.writable;
    }
  }

  // events

  onForward(buffer) {
    if (__IS_CLIENT__) {
      if (!this._proxy.isDone()) {
        // client handshake(multiple-protocols)
        this._proxy.makeHandshake(this._bsocket, buffer);
        return;
      }
      this.clientOut(buffer);
    } else {
      if (this._isRedirect) {
        // server redirect
        this.fsocketWritable && this._fsocket.write(buffer);
        return;
      }
      this.serverIn(buffer);
    }
    Profile.totalIn += buffer.length;
    // throttle receiving data to reduce memory grow:
    // https://github.com/blinksocks/blinksocks/issues/60
    if (this._fsocket && this._fsocket.bufferSize >= MAX_BUFFERED_SIZE) {
      this._bsocket.pause();
    }
  }

  onBackward(buffer) {
    if (__IS_CLIENT__) {
      this.clientIn(buffer);
    } else {
      if (this._isRedirect) {
        // server redirect
        this.bsocketWritable && this._bsocket.write(buffer);
        return;
      }
      this.serverOut(buffer);
    }
    // throttle receiving data to reduce memory grow:
    // https://github.com/blinksocks/blinksocks/issues/60
    if (this._bsocket && this._bsocket.bufferSize >= MAX_BUFFERED_SIZE) {
      this._fsocket.pause();
    }
  }

  onError(err) {
    logger.warn(`[socket] [${this.remote}] ${err.code} - ${err.message}`);
    Profile.errors += 1;
  }

  /**
   * when client/server has no data to forward
   */
  onForwardSocketDrain() {
    if (this._bsocket !== null && !this._bsocket.destroyed) {
      this._bsocket.resume();
    } else {
      this.onForwardSocketClose();
    }
  }

  onForwardSocketTimeout({host, port}) {
    logger.warn(`[socket] [${host}:${port}] timeout: no I/O on the connection for ${__TIMEOUT__}s`);
    this.onForwardSocketClose();
  }

  /**
   * when server/destination want to close then connection
   */
  onForwardSocketClose() {
    if (this._fsocket !== null && !this._fsocket.destroyed) {
      this._fsocket.destroy();
    }
    if (this._bsocket && this._bsocket.bufferSize <= 0) {
      this.onBackwardSocketClose();
    }
    if (__IS_CLIENT__ && this._tracks.length > 0) {
      this.dumpTrack();
    }
    this._fsocket = null;
  }

  /**
   * when no incoming data send to client/server
   */
  onBackwardSocketDrain() {
    if (this._fsocket !== null && !this._fsocket.destroyed) {
      this._fsocket.resume();
    } else {
      this.onBackwardSocketClose();
    }
  }

  onBackwardSocketTimeout() {
    logger.warn(`[socket] [${this.remote}] timeout: no I/O on the connection for ${__TIMEOUT__}s`);
    this.onBackwardSocketClose();
  }

  /**
   * when application/client want to close the connection
   */
  onBackwardSocketClose() {
    if (this._bsocket !== null && !this._bsocket.destroyed) {
      this._bsocket.destroy();
    }
    if (this._fsocket && this._fsocket.bufferSize <= 0) {
      this.onForwardSocketClose();
    }
    if (__IS_SERVER__ && this._tracks.length > 0) {
      this.dumpTrack();
    }
    this._bsocket = null;
    this._onClose(this); // notify hub to remove this one
  }

  /**
   * client handshake
   * @param addr
   * @param callback
   * @returns {Promise.<void>}
   */
  onHandshakeDone(addr, callback) {
    // select a server via Balancer
    const server = Balancer.getFastest();
    if (lastServer === null || !isEqual(server, lastServer)) {
      // Note: __IS_TCP__ and __IS_UDP__ are set after initServer()
      Config.initServer(server);
      lastServer = server;
      logger.info(`[balancer] use: ${__SERVER_HOST__}:${__SERVER_PORT__}`);
    }

    const [dstHost, dstPort] = [
      (addr.type === ATYP_DOMAIN) ? addr.host.toString() : ip.toString(addr.host),
      addr.port.readUInt16BE(0)
    ];

    // connect to our server
    if (__IS_TCP__) {
      logger.info(`[socket] [${this.remote}] request: ${dstHost}:${dstPort}, connecting to: ${__SERVER_HOST__}:${__SERVER_PORT__}`);
    }

    return this.connect({host: __SERVER_HOST__, port: __SERVER_PORT__}, () => {
      this._processor = this.createProcessor({
        presetsInitialParams: {'ss-base': addr}
      });
      this._tracks.push(`${dstHost}:${dstPort}`);
      this._isHandshakeDone = true;
      callback(this.onForward);
    });
  }

  // pipe chain

  clientOut(buffer) {
    let _buffer = buffer;

    if (__IS_UDP__) {
      const request = UdpRequestMessage.parse(buffer);
      if (request !== null) {
        _buffer = request.DATA;
      } else {
        logger.warn(`[socket] [${this.remote}] dropped unidentified udp message ${buffer.length} bytes`, buffer);
        return;
      }
    }

    if (this.fsocketWritable) {
      try {
        this._processor.feed(MIDDLEWARE_DIRECTION_UPWARD, _buffer);
      } catch (err) {
        logger.error(`[socket] [${this.remote}]`, err);
      }
    }
  }

  serverIn(buffer) {
    if (this.fsocketWritable || !this._isHandshakeDone) {
      try {
        this._processor.feed(MIDDLEWARE_DIRECTION_DOWNWARD, buffer);
        this._tracks.push(TRACK_CHAR_DOWNLOAD);
        this._tracks.push(buffer.length);
      } catch (err) {
        logger.error(`[socket] [${this.remote}]`, err);
      }
    }
  }

  serverOut(buffer) {
    if (this.bsocketWritable) {
      try {
        this._processor.feed(MIDDLEWARE_DIRECTION_UPWARD, buffer);
      } catch (err) {
        logger.error(`[socket] [${this.remote}]`, err);
      }
    }
  }

  clientIn(buffer) {
    if (this.bsocketWritable) {
      try {
        this._processor.feed(MIDDLEWARE_DIRECTION_DOWNWARD, buffer);
        this._tracks.push(TRACK_CHAR_DOWNLOAD);
        this._tracks.push(buffer.length);
      } catch (err) {
        logger.error(`[socket] [${this.remote}]`, err);
      }
    }
  }

  // fsocket and bsocket

  send(direction, buffer) {
    if (direction === MIDDLEWARE_DIRECTION_UPWARD) {
      if (__IS_CLIENT__) {
        this.clientForward(buffer);
      } else {
        this.serverBackward(buffer);
      }
    } else {
      if (__IS_CLIENT__) {
        this.clientBackward(buffer);
      } else {
        this.serverForward(buffer);
      }
    }
    Profile.totalOut += buffer.length;
  }

  clientForward(buffer) {
    if (this.fsocketWritable) {
      this._fsocket.write(buffer);
      this._tracks.push(TRACK_CHAR_UPLOAD);
      this._tracks.push(buffer.length);
    }
  }

  serverForward(buffer) {
    if (this.fsocketWritable) {
      this._fsocket.write(buffer);
    }
  }

  serverBackward(buffer) {
    if (this.bsocketWritable) {
      this._bsocket.write(buffer);
      this._tracks.push(TRACK_CHAR_UPLOAD);
      this._tracks.push(buffer.length);
    }
  }

  clientBackward(buffer) {
    if (this.bsocketWritable) {
      this._bsocket.write(buffer);
    }
  }

  /**
   * connect to another endpoint, for both client and server
   * @param host
   * @param port
   * @param callback
   * @returns {Promise.<void>}
   */
  async connect({host, port}, callback) {
    // host could be empty, see https://github.com/blinksocks/blinksocks/issues/34
    if (host && port) {
      this._tracks.push(`${host}:${port}`);
      if ((__IS_CLIENT__ && __IS_TCP__) || (__IS_SERVER__ && __IS_TCP_FORWARD__)) {
        try {
          const ip = await dnsCache.get(host);
          this._fsocket = net.connect({host: ip, port}, callback);
          this._fsocket.on('error', this.onError);
          this._fsocket.on('close', this.onForwardSocketClose);
          this._fsocket.on('timeout', this.onForwardSocketTimeout.bind(this, {host, port}));
          this._fsocket.on('data', this.onBackward);
          this._fsocket.on('drain', this.onForwardSocketDrain);
          this._fsocket.setTimeout(__TIMEOUT__ * 1e3);
        } catch (err) {
          logger.error(`[socket] [${this.remote}] connect to ${host}:${port} failed due to: ${err.message}`);
        }
      }
      if ((__IS_CLIENT__ && __IS_UDP__) || (__IS_SERVER__ && __IS_UDP_FORWARD__)) {
        this._fsocket = dgram.createSocket('udp4');
        this._fsocket.on('message', this.onBackward);
        // Note: implement socket.write for udp socket here.
        this._fsocket.write = (buffer) => this._fsocket.send(buffer, port, host);
        callback();
      }
    } else {
      logger.warn(`unexpected host=${host} port=${port}`);
      this.onBackwardSocketClose();
    }
  }

  // processor

  /**
   * create processor for both data forward and backward
   */
  createProcessor(options) {
    const processor = new Processor(options);
    processor.on('data', this.send.bind(this));
    processor.on('connect', ({targetAddress, onConnected}) => {
      const {host, port} = targetAddress;
      logger.info(`[socket] [${this.remote}] connecting to: ${host}:${port}`);
      return this.connect(targetAddress, () => {
        this._isHandshakeDone = true;
        onConnected();
      });
    });
    processor.on('error', this.onPresetFailed);
    return processor;
  }

  /**
   * if any preset failed, this function will be called
   * @param message
   * @param orgData
   */
  onPresetFailed({message, orgData}) {
    if (__IS_SERVER__ && __REDIRECT__ !== '' && this._fsocket === null) {
      const [host, port] = __REDIRECT__.split(':');
      logger.error(`[socket] [${this.remote}] connection is redirected to ${host}:${port} due to: ${message}`);
      this.connect({host, port}, () => {
        this._isRedirect = true;
        this.fsocketWritable && this._fsocket.write(orgData);
      });
    } else {
      const timeout = getRandomInt(10, 40);
      logger.error(`[socket] [${this.remote}] connection will be closed in ${timeout}s due to: ${message}`);
      setTimeout(() => {
        this.onForwardSocketClose();
        this.onBackwardSocketClose();
      }, timeout * 1e3);
    }
    Profile.fatals += 1;
  }

  // methods

  /**
   * print connection track string, and only record the
   * leading and the trailing TRACK_MAX_SIZE / 2
   */
  dumpTrack() {
    let strs = [];
    let dp = 0, db = 0;
    let up = 0, ub = 0;
    let ud = '';
    for (const el of this._tracks) {
      if (el === TRACK_CHAR_UPLOAD || el === TRACK_CHAR_DOWNLOAD) {
        if (ud === el) {
          continue;
        }
        ud = el;
      }
      if (Number.isInteger(el)) {
        if (ud === TRACK_CHAR_DOWNLOAD) {
          dp += 1;
          db += el;
        }
        if (ud === TRACK_CHAR_UPLOAD) {
          up += 1;
          ub += el;
        }
      }
      strs.push(el);
    }
    const perSize = Math.floor(TRACK_MAX_SIZE / 2);
    if (strs.length > TRACK_MAX_SIZE) {
      strs = strs.slice(0, perSize).concat([' ... ']).concat(strs.slice(-perSize));
    }
    const summary = __IS_CLIENT__ ? `out/in = ${up}/${dp}, ${ub}b/${db}b` : `in/out = ${dp}/${up}, ${db}b/${ub}b`;
    logger.info(`[socket] [${this.remote}] closed with summary(${summary}) abstract(${strs.join(' ')})`);
    this._tracks = [];
  }

  /**
   * close both sides
   */
  destroy() {
    this.onForwardSocketClose();
    this.onBackwardSocketClose();
  }

}
