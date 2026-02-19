var assert = require('assert');
var zt = require('../../src/index');

require('../mock-localstorage');


(function() {


  describe('client', function() {

    it('undefined context should fail', () => {
      assert.notEqual(zt, undefined);
      assert.throws(function () {
        zt.newConnection(undefined, null);
      }, /^TypeError: Specified context is undefined.$/);
    
      
    });

    it('null context should fail', () => {
      assert.notEqual(zt, undefined);
      assert.throws(function () {
        zt.newConnection(null, null);
      }, /^TypeError: Specified context is null.$/);
    });

    it('zt.init should succeed', async () => {
      let ctx = await zt.init();
      assert.notEqual(ctx, undefined);
    });

    it('zt.init should succeed', async () => {
      let ctx = await zt.init();
      assert.notEqual(ctx, undefined);
      let conn = zt.newConnection(ctx, null);
      assert.notEqual(conn, undefined);
      // console.log('conn is: ', conn);
    });

  });

})();
