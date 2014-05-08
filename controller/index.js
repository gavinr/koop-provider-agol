var request = require('request'),
  terraformer = require('terraformer'),
  terraformerParser = require('terraformer-arcgis-parser'),
  extend = require('node.extend'),
  sm = require('sphericalmercator'),
  merc = new sm({size:256}),
  crypto = require('crypto'),
  _ = require('lodash'),
  fs = require('fs');

// inherit from base controller
var Controller = extend({

  register: function(req, res){
    if ( !req.body.host ){
      res.send('Must provide a host to register:', 500); 
    } else { 
      agol.register( req.body.id, req.body.host, function(err, id){
        if (err) {
          res.send( err, 500);
        } else {
          res.json({ 'serviceId': id });
        }
      });
    }
  },

  list: function(req, res){
    agol.find(null, function(err, data){
      if (err) {
        res.send( err, 500);
      } else {
        res.json( data );
      }
    });
  }, 

  find: function(req, res){
    agol.find(req.params.id, function(err, data){
      if (err) {
        res.send( err, 500);
      } else {
        res.json( data );
      }
    });
  },

  findItem: function(req, res){
    if (req.params.format){
      Controller.findItemData(req, res);
    } else {
      agol.find(req.params.id, function(err, data){
        if (err) {
          res.send( err, 500);
        } else {
          // Get the item 
          agol.getItem( data.host, req.params.item, req.query, function(error, itemJson){
            if (error) {
              res.send( error, 500);
            } else { 
              res.json( itemJson );
            }
          });
        }
      });
    }
  },

  // drops the cache for an item
  dropItem: function(req, res){
    // if we have a layer then append it to the query params 
    if ( req.params.layer ) {
      req.query.layer = req.params.layer;
    }

    agol.find(req.params.id, function(err, data){
      if (err) {
        res.send( err, 500);
      } else {
        // Get the item 
        agol.dropItem( data.host, req.params.item, req.query, function(error, itemJson){
          if (error) {
            res.send( error, 500);
          } else {
            res.json( itemJson );
          }
        });
      }
    });
  },


  findItemData: function(req, res){
    var _get = function(id, item, key, options, callback){
       agol.find( id, function( err, data ){
        if (err) {
          callback(err, null);
        } else {
          // Get the item
          if ( !parseInt(options.layer) ){
            options.layer = 0;
          }

          agol.getItemData( data.host, item, key, options, function(error, itemJson){
            if (error) {
              callback( error, null);
            // if we have status return right away
            } else if ( itemJson.koop_status ) {
              // return w/202  
              res.json( { status: 'processing' }, 202);
            } else {
              callback( null, itemJson );
            }
          });
        }
      });  
    }; 

    // CHECK the time since our last cache entry 
    // if > 24 hours since; clear cache and wipe files 
    // else move on
    Cache.getInfo(['agol', req.params.item, (req.params.layer || 0)].join(':'), function(err, info){

      var is_expired = info ? ( new Date().getTime() >= info.expires_at ) : false;
        
      // sort the req.query before we hash so we are consistent 
      var sorted_query = {};
      _(req.query).keys().sort().each(function (key) {
        if (key != 'url_only'){
          sorted_query[key] = req.query[key];
        }
      });
      // build the file key as an MD5 hash that's a join on the paams and look for the file 
      var toHash = req.params.item + '_' + ( req.params.layer || 0 ) + JSON.stringify( sorted_query );
      var key = crypto.createHash('md5').update(toHash).digest('hex');

      // check format for exporting data
      if ( req.params.format ){

        // change geojson to json
        req.params.format = req.params.format.replace('geojson', 'json');

        // use the item as the file dir so we can organize exports by id
        var dir = req.params.item + '_' + ( req.params.layer || 0 );
        
        var fileName = [config.data_dir + 'files', dir, key + '.' + req.params.format].join('/');
        
        // if we have a layer then append it to the query params 
        if ( req.params.layer ) {
          req.query.layer = req.params.layer;
        }

        if ( fs.existsSync( fileName ) && !is_expired ){
          if ( req.query.url_only ){
            // check for Peechee
            if ( peechee ){
              peechee.path( dir, key+'.'+req.params.format, function(e, url){
                res.json({url:url});
              });
            } else {
              res.json({url: req.protocol +'://'+req.get('host') + req.originalUrl.split('?')[0]});
            }
          } else {
            res.sendfile( fileName );
          }
        } else {

          // check the koop status table to see if we have a job running 
            // if we do then return 
            // else proceed 
          req.query.format = req.params.format;
          _get(req.params.id, req.params.item, key, req.query, function( err, itemJson ){
            if (err){
              res.send(err, 500 );
            } else if ( !itemJson.data[0].features.length ){
              res.send( 'No features exist for the requested FeatureService layer', 500 );
            } else {
              Exporter.exportToFormat( req.params.format, dir, key, itemJson.data[0], function(err, result){
                if ( req.query.url_only ){
                  // check for Peechee
                  if ( peechee ){
                    peechee.path( dir, key+'.'+req.params.format, function(e, url){
                      res.json({url:url});
                    });  
                  } else {
                    res.json({url: req.protocol +'://'+req.get('host') + req.originalUrl.split('?')[0]});
                  }
                } else {
                  if (err) {
                    res.send( err, 500 );
                  } else {
                    res.sendfile( result );
                  }
                }
              });
            }
          });
        }

      } else {
        // if we have a layer then append it to the query params 
        if ( req.params.layer ) {
          req.query.layer = req.params.layer;
        }
        // get the esri json data for the service
        _get(req.params.id, req.params.item, key, req.query, function( err, itemJson ){
            if (err) {
              res.send( err, 500 );
            } else {
              if ( itemJson.data[0].features.length > 1000){
                itemJson.data[0].features = itemJson.data[0].features.splice(0,1000);
              }
              res.send( itemJson );
            }
        });
      }
    });
  },

  del: function(req, res){
    if ( !req.params.id ){
      res.send( 'Must specify a service id', 500 );
    } else { 
      agol.remove(req.params.id, function(err, data){
        if (err) {
          res.send( err, 500);
        } else {
          res.json( data );
        }
      });
    }
  }, 
  
  featureserver: function( req, res ){
    var callback = req.query.callback;
    delete req.query.callback;

    if (!req.params.layer){
      req.query.layer = 0;
    }

    agol.find(req.params.id, function(err, data){
      if (err) {
        res.send( err, 500);
      } else {
        // sort the req.query before we hash so we are consistent 
        var sorted_query = {};
        _(req.query).keys().sort().each(function (key) {
          if (key != 'url_only'){
            sorted_query[key] = req.query[key];
          }
        });
        // build the file key as an MD5 hash that's a join on the paams and look for the file 
        var toHash = req.params.item + '_' + ( req.params.layer || 0 ) + JSON.stringify( sorted_query );
        var key = crypto.createHash('md5').update(toHash).digest('hex');
        // Get the item 
        agol.getItemData( data.host, req.params.item, key, req.query, function(error, itemJson){
          if (error) {
            res.send( error, 500);
          } else {
            //GeoJSON.fromEsri( {features: itemJson.data.features}, function(err, geojson){
            //  if ( !geojson.length ) {
            //    geojson = [geojson];
            //  }
              // pass to the shared logic for FeatureService routing
              Controller._processFeatureServer( req, res, err, itemJson.data, callback);
            //});
          }
        });
      }
    });
     
  },

  thumbnail: function(req, res){

     agol.find(req.params.id, function(err, data){
      if (err) {
        res.send( err, 500);
      } else {

        // check the image first and return if exists
        var key = ['agol', req.params.id, req.params.item, (req.params.layer || 0)].join(':');
        var dir = config.data_dir + '/thumbs/';
        req.query.width = parseInt( req.query.width ) || 150;
        req.query.height = parseInt( req.query.height ) || 150;
        req.query.f_base = dir + key + '/' + req.query.width + '::' + req.query.height;
        // var png = req.query.f_base+'.png';

        var fileName = Thumbnail.exists(key, req.query); 
        if ( fileName ){
          res.sendfile( fileName );
        } else {

          // if we have a layer then pass it along
          if ( req.params.layer ) {
            req.query.layer = req.params.layer;
          }
          // sort the req.query before we hash so we are consistent 
          var sorted_query = {};
          _(req.query).keys().sort().each(function (key) {
            if (key != 'url_only'){
              sorted_query[key] = req.query[key];
            }
          });
          // build the file key as an MD5 hash that's a join on the paams and look for the file 
          var toHash = req.params.item + '_' + ( req.params.layer || 0 ) + JSON.stringify( sorted_query );
          var key = crypto.createHash('md5').update(toHash).digest('hex');

          // Get the item 
          agol.getItemData( data.host, req.params.item, key, req.query, function(error, itemJson){
            if (error) {
              res.send( error, 500);
            } else {
              GeoJSON.fromEsri({features: itemJson.data.features}, function(err, geojson){
                req.query.cache = false;

                if ( itemJson.extent ){
                  req.query.extent = {
                    xmin: itemJson.extent[0][0],
                    ymin: itemJson.extent[0][1],
                    xmax: itemJson.extent[1][0],
                    ymax: itemJson.extent[1][1]
                  }; 
                }

                // generate a thumbnail
                Thumbnail.generate( geojson, key, req.query, function(err, file){
                  if (err){
                    res.send(err, 500);
                  } else {
                    // send back image
                    res.sendfile( file );
                  }
                });
                
              });
            }
          });
        }
      }
    });

  },

  preview: function(req, res){
    res.render(__dirname + '/../views/demo', { locals: { host: req.params.id, item: req.params.item } });
  },

  tiles: function( req, res ){
    var key,
      layer = req.params.layer || 0;

    var _send = function( err, data ){
      req.params.key = key + ':' + layer;
      Tiles.get( req.params, data[0], function(err, tile){
        if ( req.params.format == 'png'){
          res.sendfile( tile );
        } else {
          res.send( tile );
        }
      });
    }

    // build the geometry from z,x,y
    var bounds = merc.bbox( req.params.x, req.params.y, req.params.z );
    req.query.geometry = {
        xmin: bounds[0],
        ymin: bounds[1],
        xmax: bounds[2],
        ymax: bounds[3],
        spatialReference: { wkid: 4326 }
    };

    var _sendImmediate = function( file ){
      if ( req.params.format == 'png'){
        res.sendfile( file );
      } else {
        res.sendfile( file );
      }
    }; 

    key = ['agol', req.params.id, req.params.item].join(':');
    var file = config.data_dir + 'tiles/';
      file += key + ':' + layer + '/' + req.params.format;
      file += '/' + req.params.z + '/' + req.params.x + '/' + req.params.y + '.' + req.params.format;

    if ( !fs.existsSync( file ) ) {
      agol.find(req.params.id, function(err, data){
        if (err) {
          res.send( err, 500);
        } else {
          // if we have a layer then pass it along
          if ( req.params.layer ) {
            req.query.layer = req.params.layer;
          }

          // sort the req.query before we hash so we are consistent 
          var sorted_query = {};
          _(req.query).keys().sort().each(function (key) {
            if (key != 'url_only'){
              sorted_query[key] = req.query[key];
            }
          });
          // build the file key as an MD5 hash that's a join on the paams and look for the file 
          var toHash = req.params.item + '_' + ( req.params.layer || 0 ) + JSON.stringify( sorted_query );
          var key = crypto.createHash('md5').update(toHash).digest('hex');

          // Get the item
          agol.getItemData( data.host, req.params.item, key, req.query, function(error, itemJson){
            if (error) {
              res.send( error, 500);
            } else {
              _send(error, itemJson.data);
            }
          });
        }
      });
    } else {
      _sendImmediate(file);
    }
  }

}, BaseController);

module.exports = Controller;
