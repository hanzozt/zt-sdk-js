/*
Copyright 2019-2020 Netfoundry, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


const isUndefined     = require('lodash.isundefined');
const isEqual         = require('lodash.isequal');
const forEach         = require('lodash.foreach');
const isNull          = require('lodash.isnull');
const formatMessage   = require('format-message');
const { PassThrough } = require('readable-stream')
const Mutex           = require('async-mutex');
const withTimeout     = require('async-mutex').withTimeout;
const Cookies         = require('js-cookie');
const CookieInterceptor = require('cookie-interceptor');
const select          = require('html-select');
const tokenize        = require('html-tokenize');
const through         = require('through2');


const ZitiContext         = require('./context/context');
const contextTypes        = require('./context/contexttypes');
const ZitiConnection      = require('./channel/connection');
const HttpRequest         = require('./http/request');
const HttpResponse        = require('./http/response');
const ZitiFormData        = require('./http/form-data');
const BrowserStdout       = require('./http/browser-stdout')
const http                = require('./http/http');
const ZitiXMLHttpRequest  = require('./http/zt-xhr');
const ZitiWebSocketWrapper = require('./http/zt-websocket-wrapper');
const LogLevel            = require('./logLevels');
const pjson               = require('../package.json');
const {throwIf}           = require('./utils/throwif');
const ZitiPKI             = require('./pki/pki');
const ZitiUPDB            = require('./updb/updb');
const ls                  = require('./utils/localstorage');
const ztConstants       = require('./constants');
const error               = require('./updb/error');

formatMessage.setup({
  // locale: 'en', // what locale strings should be displayed
  // missingReplacement: '!!NOT TRANSLATED!!', // use this when a translation is missing instead of the default message
  missingTranslation: 'ignore', // don't console.warn or throw an error when a translation is missing
})

if (!ztConfig.serviceWorker.active) {
  window.realFetch          = window.fetch;
  window.realXMLHttpRequest = window.XMLHttpRequest;
  window.realWebSocket      = window.WebSocket;
  window.realInsertBefore   = Element.prototype.insertBefore;
  window.realAppendChild    = Element.prototype.appendChild;
  window.realSetAttribute   = Element.prototype.setAttribute;
}

/**
 * @typicalname client
 */
class ZitiClient {

  constructor() {

    if (!ztConfig.serviceWorker.active) {

      CookieInterceptor.init(); // Hijack the `document.cookie` object

      CookieInterceptor.write.use( function ( cookie ) {

        let name = cookie.substring(0, cookie.indexOf("="));
        let value = cookie.substring(cookie.indexOf("=") + 1);
        let cookie_value = value.substring(0, value.indexOf(";"));

        sendMessageToServiceworker( { command: 'setCookie', name: name, value: cookie_value}  );

        (async function() { // we use an IIFE because we need to run some await calls, and we cannot make
                            // our write.use() an async func because it will then return a Promise,
                            // which would cause Cookie storage in the browser to get corrupted.
          
          console.log('=====> CookieInterceptor sees write of Cookie: ', cookie);

          const release = await zt._cookiemutex.acquire();
          let ztCookies = await ls.getWithExpiry(ztConstants.get().ZITI_COOKIES);
          if (isNull(ztCookies)) {
            ztCookies = {}
          }
          // console.log('=====> CookieInterceptor ZITI_COOKIES (before): ', ztCookies);
  
          if (cookie_value !== ''){
            let parts = value.split(";");
            let cookiePath;
            let expires;
            for (let j = 0; j < parts.length; j++) {
              let part = parts[j].trim();
              part = part.toLowerCase();
              if ( part.startsWith("path") ) {
                cookiePath = part.substring(part.indexOf("=") + 1);
              }
              else if ( part.startsWith("expires") ) {
                expires = new Date( part.substring(part.indexOf("=") + 1) );
              }
              else if ( part.startsWith("httponly") ) {
                httpOnly = true;
              }
            }
    
            ztCookies[name] = cookie_value;
       
            await ls.setWithExpiry(ztConstants.get().ZITI_COOKIES, ztCookies, new Date(8640000000000000));
    
            // console.log('=====> CookieInterceptor ZITI_COOKIES (after): ', ztCookies);
          }
  
          release();
            
        })()        

        return cookie;
      });

    }

  }


  /**
   * Initialize.
   *
   * @param {Options} [options]
   * @return {ZitiContext}
   * @api public
   */
  async init(options) {

    return new Promise( async (resolve, reject) => {

      if (isUndefined(window.realFetch)) {
        window.realFetch          = window.fetch;
        window.realXMLHttpRequest = window.XMLHttpRequest;
        window.fetch = fetch;
        window.XMLHttpRequest = ZitiXMLHttpRequest;  
      }

      let ctx = new ZitiContext(ZitiContext.prototype);

      await ctx.init(options);

      ctx.logger.success('JS SDK version %s init completed', pjson.version);

      zt._ctx = ctx;

      resolve( ctx );

    });

  };


  /**
   * Initialize from Service Worker.
   *
   * @param {Options} [options]
   * @return {ZitiContext}
   * @api public
   */
  async initFromServiceWorker(options) {

    return new Promise( async (resolve, reject) => {

      let ctx = new ZitiContext(ZitiContext.prototype);

      await ctx.init(options);

      ctx.logger.success('JS SDK version %s initFromServiceWorker completed', pjson.version);

      zt._ctx = ctx;

      resolve( ctx );

    });
  };


  /**
   * Allocate a new Connection.
   *
   * @param {ZitiContext} ctx
   * @param {*} data
   * @return {ZitiConection}
   * @api public
   */
  newConnection(ctx, data) {

    throwIf(isUndefined(ctx), formatMessage('Specified context is undefined.', { }) );
    throwIf(isEqual(ctx, null), formatMessage('Specified context is null.', { }) );

    let conn = new ZitiConnection({ 
      ctx: ctx,
      data: data
    });

    ctx.logger.debug('newConnection: conn[%d]', conn.getId());

    return conn;
  };


  /**
   * Dial the `service`.
   *
   * @param {ZitiConnection} conn
   * @param {String} service
   * @param {Object} [options]
   * @return {Conn}
   * @api public
   */
  async dial( conn, service, options = {} ) {

    let ctx = conn.getCtx();
    throwIf(isUndefined(ctx), formatMessage('Connection has no context.', { }) );

    ctx.logger.debug('dial: conn[%d] service[%s]', conn.getId(), service);

    if (isEqual( ctx.getServices().size, 0 )) {
      await ctx.fetchServices();
    }

    let service_id = ctx.getServiceIdByName(service);
    
    conn.setEncrypted(ctx.getServiceEncryptionRequiredByName(service));

    let network_session = await ctx.getNetworkSessionByServiceId(service_id);

    await ctx.connect(conn, network_session);

    ctx.logger.debug('dial: conn[%d] service[%s] encryptionRequired[%o] is now complete', conn.getId(), service, conn.getEncrypted());

  };


  /**
   * Close the `connection`.
   *
   * @param {ZitiConnection} conn
   * @api public
   */
  async close( conn ) {

    let self = this;

    return new Promise( async (resolve, reject) => {
  
      let ctx = conn.getCtx();
  
      throwIf(isUndefined(ctx), formatMessage('Connection has no context.', { }) );

      ctx.logger.debug('close: conn[%d]' , conn.getId());

      await ctx.close(conn);

      ctx.logger.debug('close: conn[%d] is now complete', conn.getId());

      resolve()

    });
  };


  /**
   * Do a 'fetch' request over the specified Ziti connection.
   *
   * @param {ZitiConnection} conn
   * @param {String} url
   * @param {Object} opts
   * @return {Promise}
   * @api public
   */
  async fetch( conn, url, opts ) {

    let ctx = conn.getCtx();

    ctx.logger.logger.debug('zt.fetch() entered');

    return new Promise( async (resolve, reject) => {

      // build HTTP request object
      let request = new HttpRequest(conn, url, opts);
      const options = await request.getRequestOptions();

      let req;

      if (options.method === 'GET') {

        req = http.get(options);

      } else {

        req = http.request(options);

        req.end();
      }

      req.on('error', err => {
        ctx.logger.logger.error('error EVENT: err: %o', err);
        reject(new Error(`request to ${request.url} failed, reason: ${err.message}`));
        finalize();
      });

      req.on('response', async res => {
        let body = res.pipe(new PassThrough());
        const response_options = {
          url: request.url,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          size: request.size,
          timeout: request.timeout,
          counter: request.counter
        };
        let response = new HttpResponse(body, response_options);
        resolve(response);
      });

    });

  }


  /**
   * Do a 'fetch' request over the specified Ziti connection, on behalf of Service Worker
   *
   * @param {String} url
   * @param {Object} opts
   * @return {Promise}
   * @api public
   */
  async fetchFromServiceWorker( url, opts ) {

    let self = this;

    return new Promise( async (resolve, reject) => {

    //   console.log('js-sdk fetchFromServiceWorker() entered', url);
    //   for (var pair of opts.headers.entries()) {
    //     console.log('js-sdk fetchFromServiceWorker() header ', pair[0]+ ': '+ pair[1]);
    //  }
     
      await zt._serviceWorkerMutexWithTimeout.runExclusive(async () => {

        console.log('js-sdk fetchFromServiceWorker() acquired zt._mutex');

        if (isUndefined(zt._ctx)) {  // If we have no context, create it now
          let ctx = new ZitiContext(ZitiContext.prototype);
          await ctx.initFromServiceWorker({ contextType: contextTypes.ServiceWorkerType, logLevel: LogLevel[ztConfig.httpAgent.ztSDKjs.logLevel] } );
          ctx.logger.success('JS SDK version %s init (fetchFromServiceWorker) completed', pjson.version);
          zt._ctx = ctx;      
        }
  
      })
      .catch(( err ) => {
        zt._ctx.logger.error(err);
        return reject( err );
      });

      let redp = new RegExp(ztConfig.httpAgent.target.host + "/zt-dom-proxy/","gi");
      let domProxyHit = (url.match(redp) || []).length;
      if ((domProxyHit > 0)) {
        url = url.replace(redp, '');
        zt._ctx.logger.debug('fetchFromServiceWorker: transformed dom-proxy url: ', url);
      }
    
      let serviceName = await zt._ctx.shouldRouteOverZiti(url).catch( async ( error ) => {
        zt._ctx.logger.debug('fetchFromServiceWorker: purging cert and API token due to err: ', error);
        await ls.removeItem( ztConstants.get().ZITI_IDENTITY_CERT );
        await ls.removeItem( ztConstants.get().ZITI_API_SESSION_TOKEN );
        return reject( error );
      });
  
      if (isUndefined(serviceName)) { // If we have no serviceConfig associated with the hostname:port, do not intercept
        return reject( new Error('no serviceConfig associated with the url: ' + url) );
      }
  
      /**
       * ------------ Now Routing over Ziti -----------------
       */
      zt._ctx.logger.debug('fetchFromServiceWorker(): serviceConfig match; intercepting [%s]', url);
    
      // build HTTP request object
      let request = new HttpRequest(serviceName, url, opts);
      let options = await request.getRequestOptions();
      options.domProxyHit = domProxyHit;
  
      let req;
  
      if (options.method === 'GET') {
  
        req = http.get(options);
  
      } else {
  
        req = http.request(options);

        if (options.body) {

          let bodyStream = options.body.stream();
          let bodyStreamReader = bodyStream.getReader();

          async function push() {
            return new Promise( async (resolve, reject) => {
              var chunk = await bodyStreamReader.read();
              if (chunk) {
                if (!chunk.done && chunk.value) {
                  req.write( chunk.value );
                  await push();
                } 
              }
              resolve();
            });
          }

          await push();
        }
  
        req.end();
      }

      zt._ctx.logger.debug('fetchFromServiceWorker(): req launched for [%s]', url);
  
      req.on('error', err => {
        zt._ctx.logger.error('error EVENT: err: %o', err);
        reject(new Error(`request to ${request.url} failed, reason: ${err.message}`));
      });
  
      req.on('response', async res => {

        zt._ctx.logger.debug('fetchFromServiceWorker(): on.response entered for [%s]', url);
  
        let body;

        if ((req.domProxyHit > 0)) {

          let reS = new RegExp("src=\"/","gi");
          let reH = new RegExp("href=\"/","gi");
          let reS2 = new RegExp("\'\/resources","gi");

          var s = select('script', function (e) {
            var tr = through.obj(function (row, buf, next) {
              let val = String(row[1]);
              if (row[0] === 'open') {
                let replace = 'src="https://' + req.host + '/';
                let newVal = val.replace(reS, replace);
                this.push([ row[0], newVal ]);
              }
              else if (row[0] === 'text') {
                let replace = "'https://" + req.host + "/resources";
                let newVal = val.replace(reS2, replace);
                zt._ctx.logger.debug('newVal [%s]', newVal);
                this.push([ row[0], newVal ]);
              } else {
                this.push([ row[0], val ]);
              }
              next();
            });
            tr.pipe(e.createStream()).pipe(tr);
          });

          var l = select('link', function (e) {
            var tr = through.obj(function (row, buf, next) {
              let val = String(row[1]);
              if (row[0] === 'open') {
                let replace = 'href="https://' + req.host + '/';
                let newVal = val.replace(reH, replace);
                this.push([ row[0], newVal ]);
              } else {
                this.push([ row[0], val ]);
              }
              next();
            });
            tr.pipe(e.createStream()).pipe(tr);
          });

          var h = select('html', function (e) {
            var tr = through.obj(function (row, buf, next) {
              let val = String(row[1]);
              if (row[0] === 'open') {
                zt._ctx.logger.debug('fetchFromServiceWorker(): in <html>, see open of [%s]', val);
                let newVal = val;
                if (val == '<html>') {
                  newVal = val + 
`<base href="https://${req.host}/">
<script type="text/javascript">
var ztConfig = {
  controller: {
    api: "https://curt-controller:1280"
  },
  httpAgent: {
    self: {
        host: "browzer.duckdns.org",
        port: "8443"
    },
    target: {
      scheme: "http",
      host: "spendai-dev2.electrifai.net",
      port: "443"     
    },
    additionalTarget: {
      scheme: "http",
      host: "sisense-dev2.electrifai.net",
      port: "443"     
    },
    corsProxy: {
      hosts: "electrifai-products.oktapreview.com:443",
    },
    domProxy: {
      hosts: "sisense-dev2.electrifai.net",
    },
    ztSDKjs: {
      location: "https://zt-npm.s3.amazonaws.com/zt_sdk_js/zt.js",
      logLevel: "Debug"
    },
    ztSDKjsInjectionURL: {
      location: "",
    }
  },
  serviceWorker: {
    location: "zt-sw.js",
    active: false
  }
}
</script>
<script type="text/javascript" src="https://zt-npm.s3.amazonaws.com/zt_sdk_js/zt.js"></script>`;
                }
                this.push([ row[0], newVal ]);
              }
              else if (row[0] === 'text') {
                zt._ctx.logger.debug('fetchFromServiceWorker(): in <html>, see text of <head> [%s]', val);
                this.push([ row[0], val ]);
              } else {
                this.push([ row[0], val ]);
              }
              next();
            });
            tr.pipe(e.createStream()).pipe(tr);
          });

          body = res.pipe(tokenize()).pipe(s).pipe(l).pipe(h).pipe(through.obj(function (row, buf, next) {
                    this.push(row[1]);
                    next();
                  })).pipe(new PassThrough());

        } else {

          body = res.pipe(new PassThrough());

        }

        // Make sure browser won't kill response with a CORS error
        res.headers['access-control-allow-origin'] = 'https://' + ztConfig.httpAgent.self.host;

        let location = res.headers.location;
        if (!isUndefined(location)) {
          location = location.replace(`redirect_uri=${ztConfig.httpAgent.target.scheme}%`, `redirect_uri=https%`);            
          let targetHost = `${ztConfig.httpAgent.target.host}`;
          targetHost = targetHost.toLowerCase();
          location = location.replace(`${targetHost}`, `${ztConfig.httpAgent.self.host}`);
          res.headers.location = location;
        }

        const response_options = {
          url: request.url,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          size: request.size,
          timeout: request.timeout,
          counter: request.counter
        };
        let response = new HttpResponse(body, response_options);

        for (const hdr in response_options.headers) {
          if (response_options.headers.hasOwnProperty(hdr)) {
            if (hdr === 'set-cookie') {
              let cookieArray = response_options.headers[hdr];
              let cookiePath;
              let expires;
              let httpOnly = false;
  
              let ztCookies = await ls.getWithExpiry(ztConstants.get().ZITI_COOKIES);
              if (isNull(ztCookies)) {
                ztCookies = {}
              }
  
              for (let i = 0; i < cookieArray.length; i++) {
  
                let cookie = cookieArray[i];
                let name = cookie.substring(0, cookie.indexOf("="));
                let value = cookie.substring(cookie.indexOf("=") + 1);
                let cookie_value = value.substring(0, value.indexOf(";"));
                if (cookie_value !== ''){
                  let parts = value.split(";");
                  for (let j = 0; j < parts.length; j++) {
                    let part = parts[j].trim();
                    if ( part.startsWith("Path") ) {
                      cookiePath = part.substring(part.indexOf("=") + 1);
                    }
                    else if ( part.startsWith("Expires") ) {
                      expires = new Date( part.substring(part.indexOf("=") + 1) );
                    }
                    else if ( part.startsWith("HttpOnly") ) {
                      httpOnly = true;
                    }
                  }
    
                  ztCookies[name] = cookie_value;
    
                  await ls.setWithExpiry(ztConstants.get().ZITI_COOKIES, ztCookies, new Date(8640000000000000));

                  Cookies.set(name, cookie_value, { expires: expires, path:  cookiePath});
                }
              }
            }
          }
        }
  
        resolve(response);
      });
    });
  
  }

}

const zt = new ZitiClient();

zt.LogLevel = LogLevel;

zt._clientMutexNoTimeout = new Mutex.Mutex();
zt._clientMutexWithTimeout = withTimeout(new Mutex.Mutex(), 30000);

zt._serviceWorkerMutexNoTimeout = new Mutex.Mutex();
zt._serviceWorkerMutexWithTimeout = withTimeout(new Mutex.Mutex(), 30000);

zt._cookiemutex = new Mutex.Mutex();

zt.VERSION = pjson.version;

module.exports = zt;


/**
 * Intercept all 'fetch' requests and route them over Ziti if the target host:port matches an active Ziti Service Config
 *
 * @param {String} url
 * @param {Object} opts
 * @return {Promise}
 * @api public
 */
ztFetch = async ( url, opts ) => {

  let serviceName;

  await zt._clientMutexWithTimeout.runExclusive(async () => {
    if (isUndefined(zt._ctx)) {  // If we have no context, create it now
      let ctx = new ZitiContext(ZitiContext.prototype);
      // await ctx.initFromServiceWorker({ contextType: contextTypes.ClientType, logLevel: LogLevel[ztConfig.httpAgent.ztSDKjs.logLevel] } );
      await ctx.init({ contextType: contextTypes.ClientType, logLevel: LogLevel[ztConfig.httpAgent.ztSDKjs.logLevel] } );
      ctx.logger.success('JS SDK version %s init (ztFetch) completed', pjson.version);
      zt._ctx = ctx;      
    }
  })
  .catch(( err ) => {
    zt._ctx.logger.error(err);
    return new Promise( async (resolve, reject) => {
      reject( err );
    });
  });

  _internal_generateKeyPair();
  let identyPresent = await _internal_isIdentityPresent();

  // We only want to intercept fetch requests that target the Ziti HTTP Agent
  var regex = new RegExp( ztConfig.httpAgent.self.host, 'g' );
  var regexSlash = new RegExp( /^\//, 'g' );
  var regexDotSlash = new RegExp( /^\.\//, 'g' );

  if (url.match( regex )) { // the request is targeting the Ziti HTTP Agent

    await zt._clientMutexNoTimeout.runExclusive(async () => {

      let isExpired = await zt._ctx.isIdentityCertExpired();

      if (isExpired) {
        let updb = new ZitiUPDB(ZitiUPDB.prototype);
        await updb.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
        await updb.awaitCredentialsAndAPISession();

        // Acquire fresh Cert
        await zt._ctx._awaitIdentityLoadComplete().catch((err) => {
          zt._ctx.logger.error(err);
          return new Promise( async (resolve, reject) => {
            reject( err );
          });
        });

        // Let sw know it should reset identity awareness
        sendMessageToServiceworker( { command: 'identityLoaded', identityLoaded: 0 }  );

        // Trigger a page reload now that we have a fresh identity
        updb.relodingPage();
        setTimeout(function(){ 
          window.location.reload();
        }, 500);
      }

    })
    .catch(( err ) => {
      zt._ctx.logger.error(err);
      return new Promise( async (resolve, reject) => {
        reject( err );
      });
    });

    var newUrl = new URL( url );
    newUrl.hostname = ztConfig.httpAgent.target.host;
    newUrl.port = ztConfig.httpAgent.target.port;
    zt._ctx.logger.trace( 'ztFetch: transformed URL: ', newUrl.toString());

    serviceName = await zt._ctx.shouldRouteOverZiti( newUrl );

    if (isUndefined(serviceName)) { // If we have no serviceConfig associated with the hostname:port, do not intercept
      zt._ctx.logger.warn('ztFetch(): no associated serviceConfig, bypassing intercept of [%s]', url);
      return window.realFetch(url, opts);
    }  

    url = newUrl.toString();

  } else if (url.match( regexSlash )) { // the request starts with a slash

    await zt._clientMutexNoTimeout.runExclusive(async () => {

      let isExpired = await zt._ctx.isIdentityCertExpired();

      if (isExpired) {
        let updb = new ZitiUPDB(ZitiUPDB.prototype);
        await updb.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
        await updb.awaitCredentialsAndAPISession();
      }
    })
    .catch(( err ) => {
      zt._ctx.logger.error(err);
      throw err;
    });

    let newUrl;
    let baseURIUrl = new URL( document.baseURI );
    if (baseURIUrl.hostname === ztConfig.httpAgent.self.host) {
      newUrl = new URL( 'https://' + ztConfig.httpAgent.target.host + ':' + ztConfig.httpAgent.target.port + url );
    } else {
      let baseURI = document.baseURI.replace(/\.\/$/, '');
      newUrl = new URL( baseURI + url );
    }
    zt._ctx.logger.debug( 'ztFetch: transformed URL: ', newUrl.toString());

    serviceName = await zt._ctx.shouldRouteOverZiti( newUrl );

    if (isUndefined(serviceName)) { // If we have no serviceConfig associated with the hostname:port, do not intercept
      zt._ctx.logger.warn('ztFetch(): no associated serviceConfig, bypassing intercept of [%s]', url);
      return window.realFetch(url, opts);
    }  

    url = newUrl.toString();

  } else if (url.match( regexDotSlash )) { // the request starts with a slash

    await zt._clientMutexNoTimeout.runExclusive(async () => {

      let isExpired = await zt._ctx.isIdentityCertExpired();

      if (isExpired) {
        let updb = new ZitiUPDB(ZitiUPDB.prototype);
        await updb.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
        await updb.awaitCredentialsAndAPISession();
      }
    })
    .catch(( err ) => {
      zt._ctx.logger.error(err);
      throw err;
    });

    let newUrl;
    let baseURIUrl = new URL( document.baseURI );
    if (baseURIUrl.hostname === ztConfig.httpAgent.self.host) {
      let slashUrl = url.replace('./', '/');
      newUrl = new URL( 'https://' + ztConfig.httpAgent.target.host + ':' + ztConfig.httpAgent.target.port + slashUrl );
    } else {
      let baseURI = document.baseURI.replace(/\/$/, '');
      newUrl = new URL( baseURI + url );
    }
    zt._ctx.logger.debug( 'ztFetch: transformed URL: ', newUrl.toString());

    serviceName = await zt._ctx.shouldRouteOverZiti( newUrl );

    if (isUndefined(serviceName)) { // If we have no serviceConfig associated with the hostname:port, do not intercept
      zt._ctx.logger.warn('ztFetch(): no associated serviceConfig, bypassing intercept of [%s]', url);
      return window.realFetch(url, opts);
    }  

    url = newUrl.toString();

  } else {  // the request is targeting the raw internet

    serviceName = await zt._ctx.shouldRouteOverZiti( url );

    if (isUndefined(serviceName)) { // If we have no serviceConfig associated with the hostname:port

      let routeOverCORSProxy = await zt._ctx.shouldRouteOverCORSProxy( url );

      if (routeOverCORSProxy) {     // If we hostname:port is something we need to CORS Proxy

        zt._ctx.logger.warn('ztFetch(): doing CORS Proxying of [%s]', url);

        let newUrl = new URL( url );
        let corsTargetHostname = newUrl.hostname;
        let corsTargetPort = newUrl.port;
        if (corsTargetPort === '') {
          if (newUrl.protocol === 'https:') {
            corsTargetPort = '443';
          } else {
            corsTargetPort = '80';
          }
        }
      
        let corsTargetPathname = newUrl.pathname;
        newUrl.hostname = ztConfig.httpAgent.self.host;
        newUrl.port = 443;
        newUrl.pathname = '/zt-cors-proxy/' + corsTargetHostname + ':' + corsTargetPort + corsTargetPathname;
        // newUrl.pathname = '/zt-cors-proxy/' + corsTargetHostname  + corsTargetPathname;
        zt._ctx.logger.warn( 'ztFetch: transformed URL: ', newUrl.toString());   

        return window.realFetch(newUrl, opts); // Send special request to HTTP Agent

      } else {

        zt._ctx.logger.warn('ztFetch(): no associated serviceConfig, bypassing intercept of [%s]', url);
        return window.realFetch(url, opts);
  
      }

    }  
  }

  /**
   * ------------ Now Routing over Ziti -----------------
   */
  zt._ctx.logger.trace('ztFetch(): serviceConfig match; intercepting [%s]', url);

	return new Promise( async (resolve, reject) => {

    // build HTTP request object
    let request = new HttpRequest(serviceName, url, opts);
    const options = await request.getRequestOptions();

    let req;

    if (options.method === 'GET') {

      req = http.get(options);

    } else {

      req = http.request(options);

      if (options.body) {
        if (options.body instanceof Promise) {
          let chunk = await options.body;
          req.write( chunk );
        }
        else if (options.body instanceof ZitiFormData) {

          let p = new Promise((resolve, reject) => {

            let stream = options.body.getStream();

            stream.on('error', err => {
              reject(new Error(`${err.message}`));
            });

            stream.on('end', () => {
              try {
                resolve();
              } catch (err) {
                reject(new Error(`${err.message}`));
              }
            });

            stream.pipe(BrowserStdout({req: req}))
          });

          await p;

        }
        else {
          req.write( options.body );
        }
      }

      req.end();
    }

    
    req.on('error', err => {
			zt._ctx.logger.error('error EVENT: err: %o', err);
			reject(new Error(`request to ${request.url} failed, reason: ${err.message}`));
		});

		req.on('response', async res => {
      let body = res.pipe(new PassThrough());

      const response_options = {
				url: url,
				status: res.statusCode,
				statusText: res.statusMessage,
				headers: res.headers,
				size: request.size,
				timeout: request.timeout,
				counter: request.counter
			};
      let response = new HttpResponse(body, response_options);

      for (const hdr in response_options.headers) {
        if (response_options.headers.hasOwnProperty(hdr)) {
          if (hdr === 'set-cookie') {
            let cookieArray = response_options.headers[hdr];
            let cookiePath;
            let expires;
            let httpOnly = false;

            let ztCookies = await ls.getWithExpiry(ztConstants.get().ZITI_COOKIES);
            if (isNull(ztCookies)) {
              ztCookies = {}
            }

            for (let i = 0; i < cookieArray.length; i++) {

              let cookie = cookieArray[i];
              let name = cookie.substring(0, cookie.indexOf("="));
              let value = cookie.substring(cookie.indexOf("=") + 1);
              let cookie_value = value.substring(0, value.indexOf(";"));
              if (cookie_value !== ''){
                let parts = value.split(";");
                for (let j = 0; j < parts.length; j++) {
                  let part = parts[j].trim();
                  if ( part.startsWith("Path") ) {
                    cookiePath = part.substring(part.indexOf("=") + 1);
                  }
                  else if ( part.startsWith("Expires") ) {
                    expires = new Date( part.substring(part.indexOf("=") + 1) );
                  }
                  else if ( part.startsWith("HttpOnly") ) {
                    httpOnly = true;
                  }
                }


                ztCookies[name] = cookie_value;

                await ls.setWithExpiry(ztConstants.get().ZITI_COOKIES, ztCookies, new Date(8640000000000000));

                Cookies.set(name, cookie_value, { expires: expires, path:  cookiePath});
              }
            }
          }
        }
      }
      
      resolve(response);
    });

  });

}


/**
 * 
 */
ztDocumentInsertBefore = ( elem, args ) => {
  // console.log('ztDocumentInsertBefore(): ', elem);
}


/**
 * 
 */
ztDocumentAppendChild = ( elem, args ) => {
  // console.log('ztDocumentAppendChild() elem: ', elem);
  let transformed = false;
  if (elem[0].outerHTML) {

    let domHostsArray = ztConfig.httpAgent.domProxy.hosts.split(',');

    forEach(domHostsArray, function( domHost ) {

      let re = new RegExp(domHost,"gi");
      let redp = new RegExp("zt-dom-proxy","gi");

      let hit = (elem[0].outerHTML.match(re) || []).length;
      if ((hit > 0)) {  // we see a hostname we need to transform

        hit = (elem[0].outerHTML.match(redp) || []).length;
        if ((hit == 0)) { // ...and we haven't been here before

          // Transform all occurances of the DOM Proxy hostname into a URL our sw can intercept
          let replace = ztConfig.httpAgent.self.host + '/zt-dom-proxy/' + domHost;
          try {
            if (!isUndefined(elem[0].src)) {
              let newSRC = elem[0].src.replace(re, replace);
              elem[0].src = newSRC;
              console.log('ztDocumentAppendChild() TRANSFORMED: ', elem[0].outerHTML);
              transformed = true;
            }
          }
          catch (e) {
            console.error(e);
          }
        }
      }
    });

    if (!transformed) {
      // console.log('ztDocumentAppendChild() NOT TRANSFORMED YET');

      let re = new RegExp("src\=\"\/","gi");

      let hit = (elem[0].outerHTML.match(re) || []).length;
      if ((hit > 0)) {  // we see a relative path

        console.log('ztDocumentAppendChild() starts with SLASH: ', elem[0].outerHTML);

        let replace = 'src="https://' + ztConfig.httpAgent.additionalTarget.host + '/';
        console.log('ztDocumentAppendChild() additionalTarget: ', ztConfig.httpAgent.additionalTarget.host);
        console.log('ztDocumentAppendChild() replace: ', replace);
        let newSRC = elem[0].src.replace(re, replace);
        console.log('ztDocumentAppendChild() newSRC: ', newSRC);
        elem[0].src = newSRC;
        console.log('ztDocumentAppendChild() TRANSFORMED: ', elem[0].outerHTML);
      }
    }

  }
}

/**
 * 
 */
 ztDocumentSetAttribute = ( elem, args ) => {
  // console.log('ztDocumentSetAttribute(): ', elem, args);
}


if (!ztConfig.serviceWorker.active) {
  window.fetch = ztFetch;
  window.XMLHttpRequest = ZitiXMLHttpRequest;
  window.WebSocket = ZitiWebSocketWrapper;
  
  Element.prototype.insertBefore = function() {
    ztDocumentInsertBefore.call(this, arguments);
    return window.realInsertBefore.apply(this, arguments);
  };
  Element.prototype.appendChild = function() {
    ztDocumentAppendChild.call(this, arguments);
    return window.realAppendChild.apply(this, arguments);
  };
  Element.prototype.setAttribute = function() {
    ztDocumentSetAttribute.call(this, arguments);
    return window.realSetAttribute.apply(this, arguments);
  };
}

if (typeof window !== 'undefined') {
  if (typeof window.fetch !== 'undefined') {
    window.fetch = ztFetch;
    window.XMLHttpRequest = ZitiXMLHttpRequest;
    window.WebSocket = ZitiWebSocketWrapper;

    Element.prototype.insertBefore = function() {
      ztDocumentInsertBefore.call(this, arguments);
      return window.realInsertBefore.apply(this, arguments);
    };
    Element.prototype.appendChild = function() {
      ztDocumentAppendChild.call(this, arguments);
      return window.realAppendChild.apply(this, arguments);
    };
    Element.prototype.setAttribute = function() {
      ztDocumentSetAttribute.call(this, arguments);
      return window.realSetAttribute.apply(this, arguments);
    };  
    
    window.addEventListener('beforeunload', function (e) {

      if (!isUndefined(zt._ctx)) {
      }

      //TEMP
      // purgeSensitiveValues();   // flush the IndexedDB
      
      // e.preventDefault(); // If you prevent default behavior in Mozilla Firefox prompt will always be shown
      // e.returnValue = '';       // Chrome requires returnValue to be set

      return undefined;

    });    
      
  }
}

/**
 * 
 */
_sendResponse = ( event, responseObject ) => {

  var data = {
    command: event.data.command,  // echo this back
    response: responseObject
  };
  event.ports[0].postMessage( data );

}


/**
 * 
 */
_onMessage_setControllerApi = async ( event ) => {
  await ls.setWithExpiry(ztConstants.get().ZITI_CONTROLLER, event.data.controller, new Date(8640000000000000));
  _sendResponse( event, 'OK' );
}


/**
 * 
 */
 _internal_generateKeyPair = async ( ) => {
  let pki = new ZitiPKI(ZitiPKI.prototype);
  await pki.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
  pki.generateKeyPair();  // initiate keypair calculation
}
_onMessage_generateKeyPair = async ( event ) => {
  // _internal_generateKeyPair();
  _sendResponse( event, 'OK' );
}


/**
 * 
 */
 _onMessage_isKeyPairPresent = async ( event ) => {
  let pki = new ZitiPKI(ZitiPKI.prototype);
  let haveKeys = await pki._haveKeypair();
  if (haveKeys) {
    _sendResponse( event, '1' );
  } else {
    _sendResponse( event, '0' );
  }
}


/**
 * 
 */
_internal_isIdentityPresent = async ( ) => {

  return new Promise( async function(resolve, reject) {

    let identyPresent = false;


    // await zt._serviceWorkerMutexNoTimeout.runExclusive(async () => {  // enter critical-section

      let apisess = await ls.getWithExpiry(ztConstants.get().ZITI_API_SESSION_TOKEN);

      if (isNull( apisess ) || isUndefined( apisess )) {
        await ls.removeItem( ztConstants.get().ZITI_NETWORK_SESSIONS );
        await ls.removeItem( ztConstants.get().ZITI_IDENTITY_CERT );
      }
      else {
        let cert = await ls.getWithExpiry(ztConstants.get().ZITI_IDENTITY_CERT);
        if (!isNull( cert ) && !isUndefined( cert )) {
          identyPresent = true;
        } else {
          // If cert expired, purge any session data we might have
          await ls.removeItem( ztConstants.get().ZITI_API_SESSION_TOKEN );
          await ls.removeItem( ztConstants.get().ZITI_NETWORK_SESSIONS );
          // and also reset the channels
          if (!isUndefined(zt._ctx)) {
            zt._ctx.closeAllChannels();
          }
        }
      }
    // });

    return resolve(identyPresent);
    
  });
}
_onMessage_isIdentityPresent = async ( event ) => {
  let identyPresent = await _internal_isIdentityPresent();
  if ( identyPresent ) {
    _sendResponse( event, '1' );
  } else {
    _sendResponse( event, '0' );
  }
}


/**
 * 
 */
 _onMessage_promptForZitiCreds = async ( event ) => {

  let username = await ls.getWithExpiry( ztConstants.get().ZITI_IDENTITY_USERNAME );
  let password = await ls.getWithExpiry( ztConstants.get().ZITI_IDENTITY_PASSWORD );

  if (
    isNull( username ) || isUndefined( username ) ||
    isNull( password ) || isUndefined( password )
  ) {

    let updb = new ZitiUPDB(ZitiUPDB.prototype);
  
    await updb.init( { ctx: zt._ctx, logger: zt._ctx.logger } );

    await updb.awaitCredentialsAndAPISession();
  
    // Do not proceed until we have a keypair (this will render a dialog to the user informing them of status)
    let pki = new ZitiPKI(ZitiPKI.prototype);
    await pki.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
    await pki.awaitKeyPairGenerationComplete(); // await completion of keypair calculation
  
    // Trigger a page reload now that we have creds and keypair
    setTimeout(function(){ 
      window.location.reload();
    }, 1000);
    // setTimeout(function(){ window.location.href = window.location.href }, 1000);  
  }

  _sendResponse( event, 'OK' );
}


/**
 * 
 */
 _onMessage_promptForZitiCredsNoWait = async ( event ) => {

  _sendResponse( event, 'OK' ); // release the sw immediately

  await zt._serviceWorkerMutexNoTimeout.runExclusive(async () => {  // enter critical-section

    if (isUndefined(zt._ctx)) {
      let ctx = new ZitiContext(ZitiContext.prototype);
      await ctx.initFromServiceWorker({ logLevel: LogLevel[event.data.options.logLevel] } );
      ctx.logger.success('JS SDK version %s (_onMessage_promptForZitiCredsNoWait) completed', pjson.version);
      zt._ctx = ctx;
    }

    let apisess = await ls.getWithExpiry(ztConstants.get().ZITI_API_SESSION_TOKEN);
    let cert    = await ls.getWithExpiry(ztConstants.get().ZITI_IDENTITY_CERT);

    zt._ctx.logger.debug('_onMessage_promptForZitiCredsNoWait: apisess is: %o, cert is: %o', apisess, cert);

    if ( isNull( apisess ) || isUndefined( apisess ) || isNull( cert ) || isUndefined( cert ) ) {

      // Let sw know we do NOT have an identity
      sendMessageToServiceworker( { command: 'identityLoaded', identityLoaded: 0 }  );

      let updb = new ZitiUPDB(ZitiUPDB.prototype);

      await updb.init( { ctx: zt._ctx, logger: zt._ctx.logger } );

      let haveKeypair = await updb._haveKeypair();

      if (!haveKeypair) {

        let keypairPresent = await updb.awaitKeypair( ztConstants.get().ZITI_IDENTITY_KEYPAIR_OBTAIN_FROM_FS );
        zt._ctx.logger.debug('_onMessage_promptForZitiCredsNoWait: awaitKeypair returned [%o]', keypairPresent);

        if (keypairPresent == ztConstants.get().ZITI_IDENTITY_PUBLIC_KEY_FILE_NOT_FOUND ||  keypairPresent ==  ztConstants.get().ZITI_IDENTITY_PRIVATE_KEY_FILE_NOT_FOUND) {

          // If keypair not in FS or IDB, then initiate keypair generation
          _internal_generateKeyPair();

          // Do not proceed until we have a keypair (this will render a dialog to the user informing them of status)
          let pki = new ZitiPKI(ZitiPKI.prototype);
          await pki.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
          await pki.awaitKeyPairGenerationComplete(); // await completion of keypair calculation
  
          keypairPresent = await updb.awaitKeypair( ztConstants.get().ZITI_IDENTITY_KEYPAIR_OBTAIN_FROM_IDB );
          zt._ctx.logger.debug('_onMessage_promptForZitiCredsNoWait: awaitKeypair returned [%o]', keypairPresent);

          if (keypairPresent !== ztConstants.get().ZITI_IDENTITY_KEYPAIR_FOUND) {
            throw new Error('should not happen');
          } else {

            zt._ctx.logger.debug('_onMessage_promptForZitiCredsNoWait: now have the keypair we need, so proceeding to obtain creds');

          }
        }
      }

      let haveCreds = await updb._haveCreds();

      if (!haveCreds) {

        await updb.awaitCredentialsAndAPISession();

      } else {

        // Remain in this loop until the creds entered on login form are acceptable to the Ziti Controller
        let validCreds;
        do {
          validCreds = await zt._ctx.getFreshAPISession();
        } while ( !validCreds );

      }

      // Do not proceed until we have a keypair (this will render a dialog to the user informing them of status)
      let pki = new ZitiPKI(ZitiPKI.prototype);
      await pki.init( { ctx: zt._ctx, logger: zt._ctx.logger } );
      await pki.awaitKeyPairGenerationComplete(); // await completion of keypair calculation

      // Acquire the Cert
      await zt._ctx._awaitIdentityLoadComplete().catch((err) => {
        zt._ctx.logger.error(err);
      });

      // Let sw know we now have an identity
      sendMessageToServiceworker( { command: 'identityLoaded', identityLoaded: 1 }  );

      // Trigger a page reload now that we have creds and keypair
      setTimeout(function() {
    
        zt._ctx.logger.info('_onMessage_promptForZitiCredsNoWait: triggering page reload now');
        window.location.reload();
      
      }, 500);
    }
  });
}


/**
 * 
 */
_onMessage_initClient = async ( event ) => {

  await zt._serviceWorkerMutexWithTimeout.runExclusive(async () => {
    if (isUndefined(zt._ctx)) {
      let ctx = new ZitiContext(ZitiContext.prototype);
      await ctx.initFromServiceWorker({ logLevel: LogLevel[event.data.options.logLevel] } );
      ctx.logger.success('JS SDK version %s initFromServiceWorker completed', pjson.version);
      zt._ctx = ctx;
    }
  })
  .catch(( err ) => {
    throw err;
  });

  _sendResponse( event, 'OK' );
}


/**
 * 
 */
_onMessage_purgeCert = async ( event ) => {
  await ls.removeItem( ztConstants.get().ZITI_IDENTITY_CERT );
  await ls.removeItem( ztConstants.get().ZITI_API_SESSION_TOKEN );
  _sendResponse( event, 'nop OK' );
}


/**
 * 
 */
 _onMessage_getCookies = async ( event ) => {
  console.log('JS SDK _onMessage_getCookies entered');
  // if (zt._cookiemutex.isLocked()) {
    // zt._cookiemutex.waitForUnlock();
  // }
  // let ztCookies = await ls.getWithExpiry(ztConstants.get().ZITI_COOKIES);
  // console.log('JS SDK _onMessage_getCookies returning: ', ztCookies);
  // _sendResponse( event, ztCookies );
  _sendResponse( event, 'nop OK' );
}


/**
 * 
 */
_onMessage_nop = async ( event ) => {
  _sendResponse( event, 'nop OK' );
}


if (!ztConfig.serviceWorker.active) {
  if ('serviceWorker' in navigator) {

    if (isNull(navigator.serviceWorker.controller)) {

      /**
       *  Service Worker registration
       */
      navigator.serviceWorker.register('https://' + ztConfig.httpAgent.self.host + '/zt-sw.js', {scope: './'} ).then( function( reg ) {

          if (navigator.serviceWorker.controller) {
              // If .controller is set, then this page is being actively controlled by our service worker.
              console.log('The Ziti service worker is now registered.');

              // (function checkForUpdatedServiceWorker() {
              //   console.log('checking for updated service worker.');
              //   reg.update();
              //   setTimeout( checkForUpdatedServiceWorker, 1000 * 60 * 30 );
              // })();

          } else {
              // If .controller isn't set, then prompt the user to reload the page so that the service worker can take
              // control. Until that happens, the service worker's fetch handler won't be used.
              // console.log('Please reload this page to allow the Ziti service worker to handle network operations.');
          }
      }).catch(function(error) {
          // Something went wrong during registration.
          console.error(error);
      });

    }


    /**
     *  Service Worker 'message' handler'
     */
    navigator.serviceWorker.addEventListener('message', event => {
        console.log('----- Client received msg from serviceWorker: ', event.data.command);

             if (event.data.command === 'initClient')           { _onMessage_initClient( event ); }
        else if (event.data.command === 'generateKeyPair')      { _onMessage_generateKeyPair( event ); }
        else if (event.data.command === 'setControllerApi')     { _onMessage_setControllerApi( event ); }
        else if (event.data.command === 'isKeyPairPresent')     { _onMessage_isKeyPairPresent( event ); }
        else if (event.data.command === 'isIdentityPresent')    { _onMessage_isIdentityPresent( event ); }
        else if (event.data.command === 'promptForZitiCreds')   { _onMessage_promptForZitiCreds( event ); }
        else if (event.data.command === 'promptForZitiCredsNoWait')   { _onMessage_promptForZitiCredsNoWait( event ); }
        else if (event.data.command === 'purgeCert')            { _onMessage_purgeCert( event ); }
        else if (event.data.command === 'getCookies')           { _onMessage_getCookies( event ); }
        
        else if (event.data.command === 'nop')                  { _onMessage_nop( event ); }

        else { throw new Error('unknown message.command received [' + event.data.command + ']'); }
    });


    /**
     * 
     */
    navigator.serviceWorker.startMessages();

    // Kiosk mode?
    if (window.opener) {
      // wait for messages from opener
      window.addEventListener( 'message', function( e ) {
        this.window.kioskZitiUserName = e.data.username;
        this.window.kioskZitiPassword = e.data.password;
      });

      // tell the opener we are waiting
      window.opener.postMessage( 'inited', '*' );
    }

      
  } else {
    console.error("The current browser doesn't support service workers");
  }
}


/**
 * 
 */
async function sendMessageToServiceworker( message ) {

  return new Promise(function(resolve, reject) {

      var messageChannel = new MessageChannel();

      messageChannel.port1.onmessage = function( event ) {
          if (event.data.error) {
              reject(event.data.error);
          } else {
              resolve(event.data);
          }
      };

      if (!isUndefined(navigator.serviceWorker)) {
        if (!isUndefined(navigator.serviceWorker.controller)) {
          navigator.serviceWorker.controller.postMessage(message, [ messageChannel.port2 ]);
        }
      }
  });
}


/**
 * 
 */
async function purgeSensitiveValues() {

  await ls.removeItem( ztConstants.get().ZITI_CONTROLLER );               // The location of the Controller REST endpoint
  await ls.removeItem( ztConstants.get().ZITI_SERVICES );                 // 
  await ls.removeItem( ztConstants.get().ZITI_API_SESSION_TOKEN );        // 
  await ls.removeItem( ztConstants.get().ZITI_NETWORK_SESSIONS );         // 
  // await ls.removeItem( ztConstants.get().ZITI_COOKIES );                  // 
  await ls.removeItem( ztConstants.get().ZITI_CLIENT_CERT_PEM );          // 
  await ls.removeItem( ztConstants.get().ZITI_CLIENT_PRIVATE_KEY_PEM );   // 
  await ls.removeItem( ztConstants.get().ZITI_IDENTITY_CERT );            // 
   
}


/**
 * Propagate the cookies from the browser's cookie cache into the Ziti-owned storage.
 */
async function propagateBrowserCookieValues() {

  let ztCookies = await ls.getWithExpiry(ztConstants.get().ZITI_COOKIES);
  if (isNull(ztCookies)) {
    ztCookies = {}
  }

  // Obtain all Cookie KV pairs from the browser Cookie cache
	let browserCookies = Cookies.get();
	for (const cookie in browserCookies) {
		if (browserCookies.hasOwnProperty( cookie )) {
			ztCookies[cookie] = browserCookies[cookie];
		}
	}

  await ls.setWithExpiry(ztConstants.get().ZITI_COOKIES, ztCookies, new Date(8640000000000000));
}


async function purgeExpiredValues() {

  propagateBrowserCookieValues();
 
  // await ls.getWithExpiry( ztConstants.get().ZITI_CONTROLLER );               // The location of the Controller REST endpoint
  // await ls.getWithExpiry( ztConstants.get().ZITI_SERVICES );                 // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_API_SESSION_TOKEN );        // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_NETWORK_SESSIONS );         // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_COOKIES );                  // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_CLIENT_CERT_PEM );          // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_CLIENT_PRIVATE_KEY_PEM );   // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_IDENTITY_CERT );            // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_IDENTITY_USERNAME );        // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_IDENTITY_PASSWORD );        // 
  // await ls.getWithExpiry( ztConstants.get().ZITI_COOKIES );                  // 

  setTimeout(purgeExpiredValues, (1000 * 5) );  // pulse this function every few seconds
}

setTimeout(purgeExpiredValues, 1 );
