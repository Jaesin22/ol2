/* Copyright (c) 2006-2015 by OpenLayers Contributors (see authors.txt for
 * full list of contributors). Published under the 2-clause BSD license.
 * See license.txt in the OpenLayers distribution or repository for the
 * full text of the license. */

/**
 * @requires OpenLayers/Format/XML.js
 * @requires OpenLayers/Feature/Vector.js
 * @requires OpenLayers/Geometry/Point.js
 * @requires OpenLayers/Geometry/LineString.js
 * @requires OpenLayers/Geometry/Polygon.js
 * @requires OpenLayers/Projection.js
 */

/**
 * Class: OpenLayers.Format.OSM
 * OSM parser. Create a new instance with the
 *     <OpenLayers.Format.OSM> constructor.
 *
 * Inherits from:
 *  - <OpenLayers.Format.XML>
 */
OpenLayers.Format.OSM = OpenLayers.Class(OpenLayers.Format.XML, {

    /**
     * APIProperty: checkTags
     * {Boolean} Should tags be checked to determine whether something
     * should be treated as a separate node. Will slow down parsing.
     * Default is false.
     */
    checkTags: false,

    /**
     * APIProperty: shareNode
     * {Boolean} Should nodes be shared between geometries.
     */
    shareNode: false,

    /**
     * Property: interestingTagsExclude
     * {Array} List of tags to exclude from 'interesting' checks on nodes.
     * Must be set when creating the format. Will only be used if checkTags
     * is set.
     */
    interestingTagsExclude: null,

    /**
     * APIProperty: areaTags
     * {Array} List of tags indicating that something is an area.
     * Must be set when creating the format. Will only be used if
     * checkTags is true.
     */
    areaTags: null,

    /**
     * APIProperty: relationsParsers
     * {Map({String, Function})} Map relation type to a functions that parce the relation.
     * This can be set for example to:
     * {
     *     multipolygon: OpenLayers.Format.OSM.multipolygonParser,
     *     boundary:     OpenLayers.Format.OSM.multipolygonParser,
     *     route:        OpenLayers.Format.OSM.routeParser
     * }
     */
    relationsParsers: {},

    /**
     * Constructor: OpenLayers.Format.OSM
     * Create a new parser for OSM.
     *
     * Parameters:
     * options - {Object} An optional object whose properties will be set on
     *     this instance.
     */
    initialize: function(options) {
        var layer_defaults = {
          'interestingTagsExclude': ['source', 'source_ref',
              'source:ref', 'history', 'attribution', 'created_by'],
          'areaTags': ['area', 'building', 'leisure', 'tourism', 'ruins',
              'historic', 'landuse', 'military', 'natural', 'sport']
        };
        options = options ? options : {};

        layer_defaults = OpenLayers.Util.extend(layer_defaults, options);

        var interesting = {};
        for (var i = 0; i < layer_defaults.interestingTagsExclude.length; i++) {
            interesting[layer_defaults.interestingTagsExclude[i]] = true;
        }
        layer_defaults.interestingTagsExclude = interesting;

        var area = {};
        for (var i = 0; i < layer_defaults.areaTags.length; i++) {
            area[layer_defaults.areaTags[i]] = true;
        }
        layer_defaults.areaTags = area;

        // OSM coordinates are always in longlat WGS84
        this.externalProjection = new OpenLayers.Projection("EPSG:4326");

        OpenLayers.Format.XML.prototype.initialize.apply(this, [layer_defaults]);
    },

    /**
     * APIMethod: read
     * Return a list of features from a OSM doc

     * Parameters:
     * doc - {Element} 
     *
     * Returns:
     * Array({<OpenLayers.Feature.Vector>})
     */
    read: function(doc) {
        if (typeof doc == "string") {
            doc = OpenLayers.Format.XML.prototype.read.apply(this, [doc]);
        }

        var nodes = this.getNodes(doc);
        var ways = this.getWays(doc);
        var relations = this.getRelations(doc);

        // Geoms will contain at least ways.length entries.
        var feat_list = [];

        for (var relation_id in relations) {
            var relation = relations[relation_id];
            if (this.relationsParsers[relation.tags.type]) {
                var features = this.relationsParsers[relation.tags.type](relation, this, nodes, ways, relations);
                for (var i = 0, len = features.length ; i < len ; i++) {
                    feat_list.push(features[i]);
                }
            }
        }

        for (var way_id in ways) {
            var way = ways[way_id];

            if (way.interesting) {
                var poly = this.isWayArea(way) ? 1 : 0;
                var point_list = this.getPointList(way, nodes);
                var geometry = null;
                if (poly) {
                    geometry = new OpenLayers.Geometry.Polygon(
                        new OpenLayers.Geometry.LinearRing(point_list));
                }
                else {
                    geometry = new OpenLayers.Geometry.LineString(point_list);
                }
                var feat = new OpenLayers.Feature.Vector(geometry,
                    way.tags);
                feat.osm_id = parseInt(way.id);
                feat.osm_version = parseInt(way.version);
                // Since OSM is topological, we stash the node ID internally.
                feat.geometry.osm_id = feat.osm_id;
                feat.type = "way";
                feat.fid = "way." + feat.osm_id;
                feat_list.push(feat);
            }
        }
        for (var node_id in nodes) {
            var node = nodes[node_id];
            if (!node.used || !this.checkTags || Object.keys(node.attributes).length > 1) {
                feat_list.push(node);
            }
        }
        return feat_list;
    },

    /**
     * Method: getPointList
     * Return a list of points corresponds with with the way.
     *
     * Parameters:
     * way - way where we can find the nodes id.
     * nodes - nodes the nodes map where we can find the nodes by id.
     */
    getPointList: function(way, nodes) {
        if (!way) {
            // the way will not be on the bbox
            return [];
        }
        // We know the minimal of this one ahead of time. (Could be -1
        // due to areas/polygons)
        var point_list = new Array(way.nodes.length);
        for (var j = 0; j < way.nodes.length; j++) {
            var node = nodes[way.nodes[j]];
            node.used = true;

            var point = node.geometry;
            if (!this.shareNode) {
                point = new OpenLayers.Geometry.Point(node.geometry.x, node.geometry.y);
                // Since OSM is topological, we stash the node ID internally.
                point.osm_id = node.osm_id;
            }

            point_list[j] = point;
        }
        return point_list;
    },

    /**
     * Method: concatPathsIfLinear
     * Return result.succed if pass are linear, result.lastPointList with the new way.
     *
     * Parameters:
     * lastPointList - array of <OpenLayer.Geometry.Points>, the old concanated path
     * pointList - array of <OpenLayer.Geometry.Points>, the new path
     */
    concatPathsIfLinear: function(lastPointList, pointList) {
        var result = {};
        if (lastPointList.length == 0) {
            result.succed = true;
            result.lastPointList = pointList;
            return result;
        }
        if (pointList.length == 0) {
            result.succed = true;
            result.lastPointList = lastPointList;
            return result;
        }
        if (lastPointList[lastPointList.length-1].x == pointList[0].x
         && lastPointList[lastPointList.length-1].y == pointList[0].y) {
            pointList = pointList.slice(1, pointList.length);
            lastPointList = lastPointList.concat(pointList);
            result.succed = true;
            result.lastPointList = lastPointList;
            return result;
        }
        else if (lastPointList[0].x == pointList[pointList.length-1].x
              && lastPointList[0].y == pointList[pointList.length-1].y) {
            lastPointList = lastPointList.slice(1, lastPointList.length);
            lastPointList = pointList.concat(lastPointList);
            result.succed = true;
            result.lastPointList = lastPointList;
            return result;
        }
        else if (lastPointList[0].x == pointList[0].x
              && lastPointList[0].y == pointList[0].y) {
            if (lastPointList.length > pointList.length) {
                pointList = pointList.slice(1, pointList.length);
                lastPointList = pointList.reverse().concat(lastPointList);
            }
            else {
                lastPointList = lastPointList.slice(1, lastPointList.length);
                lastPointList = lastPointList.reverse().concat(pointList);
            }
            result.succed = true;
            result.lastPointList = lastPointList;
            return result;
        }
        else if (lastPointList[lastPointList.length-1].x == pointList[pointList.length-1].x
              && lastPointList[lastPointList.length-1].y == pointList[pointList.length-1].y) {
            if (lastPointList.length > pointList.length) {
                pointList = pointList.slice(0, pointList.length - 1);
                lastPointList = lastPointList.concat(pointList.reverse());
            }
            else {
                lastPointList = lastPointList.slice(0, lastPointList.length - 1);
                lastPointList = pointList.concat(lastPointList.reverse());
            }
            result.succed = true;
            result.lastPointList = lastPointList;
            return result;
        }
        result.succed = false;
        return result;
    },

    /**
     * Method: gets
     * Return the node items from a doc.
     *
     * Parameters:
     * doc - {DOMElement} node to parse tags from
     */
    getNodes: function(doc) {
        var node_list = doc.getElementsByTagName("node");
        var nodes = {};
        for (var i = 0; i < node_list.length; i++) {
            var node = node_list[i];
            var id = node.getAttribute("id");
            var geom = new OpenLayers.Geometry.Point(
                    node.getAttribute("lon"),
                    node.getAttribute("lat"))
            if (this.internalProjection && this.externalProjection) {
                geom.transform(this.externalProjection,
                    this.internalProjection);
            }
            var feat = new OpenLayers.Feature.Vector(geom, this.getTags(node));
            feat.osm_id = parseInt(id);
            feat.osm_version = parseInt(node.getAttribute("version"));
            feat.type = "node";
            feat.fid = "node." + feat.osm_id;

            // Since OSM is topological, we stash the node ID internally.
            feat.geometry.osm_id = feat.osm_id;

            nodes[id] = feat;
        }
        return nodes;
    },

    /**
     * Method: getRelations
     * Return the relation items from a doc.
     *
     * Parameters:
     * node - {DOMElement} node to parse tags from
     */
    getRelations: function(doc) {
        var relation_list = doc.getElementsByTagName("relation");
        var return_relations = {};
        for (var i = 0; i < relation_list.length; i++) {
            var relation = relation_list[i];
            var id = relation.getAttribute("id");
            var relation_object = {
              id: id,
              version: relation.getAttribute("version")
            };

            relation_object.tags = this.getTags(relation);
            relation_object.nodes = [];
            relation_object.ways = [];
            relation_object.relations = [];

            var member_list = relation.getElementsByTagName("member");

            for (var j = 0; j < member_list.length; j++) {
                var member = member_list[j];
                var type = member.getAttribute("type");
                if (type == 'node') {
                    relation_object.nodes[relation_object.nodes.length] = member;
                }
                else if (type == 'way') {
                    relation_object.ways[relation_object.ways.length] = member;
                }
                else if (type == 'relation') {
                    relation_object.relations[relation_object.relations.length] = member;
                }
            }
            return_relations[id] = relation_object;
        }
        return return_relations;

    },

    /**
     * Method: getWays
     * Return the way items from a doc.
     *
     * Parameters:
     * doc - {DOMElement} node to parse tags from
     */
    getWays: function(doc) {
        var way_list = doc.getElementsByTagName("way");
        var return_ways = {};
        for (var i = 0; i < way_list.length; i++) {
            var way = way_list[i];
            var id = way.getAttribute("id");
            var way_object = {
              id: id,
              version: way.getAttribute("version")
            };

            if (this.checkTags) {
                var result = this.getTags(way, true);
                way_object.interesting = result[1];
                way_object.tags = result[0];
            } else {
                way_object.interesting = true;
                way_object.tags = this.getTags(way);
            }

            var node_list = way.getElementsByTagName("nd");

            way_object.nodes = new Array(node_list.length);

            for (var j = 0; j < node_list.length; j++) {
                way_object.nodes[j] = node_list[j].getAttribute("ref");
            }
            return_ways[id] = way_object;
        }
        return return_ways;

    },

    /**
     * Method: getTags
     * Return the tags list attached to a specific DOM element.
     *
     * Parameters:
     * dom_node - {DOMElement} node to parse tags from
     * interesting_tags - {Boolean} whether the return from this function should
     *    return a boolean indicating that it has 'interesting tags' --
     *    tags like attribution and source are ignored. (To change the list
     *    of tags, see interestingTagsExclude)
     *
     * Returns:
     * tags - {Object} hash of tags
     * interesting - {Boolean} if interesting_tags is passed, returns
     *     whether there are any interesting tags on this element.
     */
    getTags: function(dom_node, interesting_tags) {
        var tag_list = dom_node.getElementsByTagName("tag");
        var tags = {};
        var interesting = false;
        for (var j = 0; j < tag_list.length; j++) {
            var key = tag_list[j].getAttribute("k");
            if (!this.checkTags || !this.interestingTagsExclude[key]) {
                tags[key] = tag_list[j].getAttribute("v");
            }
            if (interesting_tags && !this.interestingTagsExclude[key]) {
                interesting = true;
            }
        }
        return interesting_tags ? [tags, interesting] : tags;
    },

    /**
     * Method: isWayArea
     * Given a way object from getWays, check whether the tags and geometry
     * indicate something is an area.
     *
     * Returns:
     * {Boolean}
     */
    isWayArea: function(way) {
        var poly_shaped = false;
        var poly_tags = false;

        if (way.nodes[0] == way.nodes[way.nodes.length - 1]) {
            poly_shaped = true;
        }
        if (this.checkTags) {
            for(var key in way.tags) {
                if (this.areaTags[key]) {
                    poly_tags = true;
                    break;
                }
            }
        }
        return poly_shaped && (this.checkTags ? poly_tags : true);
    },

    /**
     * APIMethod: write
     * Takes a list of features, returns a serialized OSM format file for use
     * in tools like JOSM.
     *
     * Parameters:
     * features - {Array(<OpenLayers.Feature.Vector>)}
     */
    write: function(features) {
        if (!(OpenLayers.Util.isArray(features))) {
            features = [features];
        }

        this.osm_id = 1;
        this.created_nodes = {};
        var root_node = this.createElementNS(null, "osm");
        root_node.setAttribute("version", "0.5");
        root_node.setAttribute("generator", "OpenLayers "+ OpenLayers.VERSION_NUMBER);

        // Loop backwards, because the deserializer puts nodes last, and
        // we want them first if possible
        for(var i = features.length - 1; i >= 0; i--) {
            var nodes = this.createFeatureNodes(features[i]);
            for (var j = 0; j < nodes.length; j++) {
                root_node.appendChild(nodes[j]);
            }
        }
        return OpenLayers.Format.XML.prototype.write.apply(this, [root_node]);
    },

    /**
     * Method: createFeatureNodes
     * Takes a feature, returns a list of nodes from size 0->n.
     * Will include all pieces of the serialization that are required which
     * have not already been created. Calls out to createXML based on geometry
     * type.
     *
     * Parameters:
     * feature - {<OpenLayers.Feature.Vector>}
     */
    createFeatureNodes: function(feature) {
        var nodes = [];
        var className = feature.geometry.CLASS_NAME;
        var type = className.substring(className.lastIndexOf(".") + 1);
        type = type.toLowerCase();
        var builder = this.createXML[type];
        if (builder) {
            nodes = builder.apply(this, [feature]);
        }
        return nodes;
    },

    /**
     * Method: createXML
     * Takes a feature, returns a list of nodes from size 0->n.
     * Will include all pieces of the serialization that are required which
     * have not already been created.
     *
     * Parameters:
     * feature - {<OpenLayers.Feature.Vector>}
     */
    createXML: {
        'point': function(point) {
            var id = null;
            var geometry = point.geometry ? point.geometry : point;

            if (this.internalProjection && this.externalProjection) {
                geometry = geometry.clone();
                geometry.transform(this.internalProjection,
                                   this.externalProjection);
            }

            var already_exists = false; // We don't return anything if the node
                                        // has already been created
            if (point.osm_id) {
                id = point.osm_id;
                if (this.created_nodes[id]) {
                    already_exists = true;
                }
            } else {
               id = -this.osm_id;
               this.osm_id++;
            }
            if (already_exists) {
                node = this.created_nodes[id];
            } else {
                var node = this.createElementNS(null, "node");
            }
            this.created_nodes[id] = node;
            node.setAttribute("id", id);
            node.setAttribute("lon", geometry.x);
            node.setAttribute("lat", geometry.y);
            if (point.attributes) {
                this.serializeTags(point, node);
            }
            this.setState(point, node);
            return already_exists ? [] : [node];
        },
        linestring: function(feature) {
            var id;
            var nodes = [];
            var geometry = feature.geometry;
            if (feature.osm_id) {
                id = feature.osm_id;
            } else {
                id = -this.osm_id;
                this.osm_id++;
            }
            var way = this.createElementNS(null, "way");
            way.setAttribute("id", id);
            for (var i = 0; i < geometry.components.length; i++) {
                var node = this.createXML['point'].apply(this, [geometry.components[i]]);
                if (node.length) {
                    node = node[0];
                    var node_ref = node.getAttribute("id");
                    nodes.push(node);
                } else {
                    node_ref = geometry.components[i].osm_id;
                    node = this.created_nodes[node_ref];
                }
                this.setState(feature, node);
                var nd_dom = this.createElementNS(null, "nd");
                nd_dom.setAttribute("ref", node_ref);
                way.appendChild(nd_dom);
            }
            this.serializeTags(feature, way);
            nodes.push(way);

            return nodes;
        },
        polygon: function(feature) {
            var attrs = OpenLayers.Util.extend({'area':'yes'}, feature.attributes);
            var feat = new OpenLayers.Feature.Vector(feature.geometry.components[0], attrs);
            feat.osm_id = feature.osm_id;
            // Since OSM is topological, we stash the node ID internally.
            feat.geometry.osm_id = feat.osm_id;
            return this.createXML['linestring'].apply(this, [feat]);
        }
    },

    /**
     * Method: serializeTags
     * Given a feature, serialize the attributes onto the given node.
     *
     * Parameters:
     * feature - {<OpenLayers.Feature.Vector>}
     * node - {DOMNode}
     */
    serializeTags: function(feature, node) {
        for (var key in feature.attributes) {
            var tag = this.createElementNS(null, "tag");
            tag.setAttribute("k", key);
            tag.setAttribute("v", feature.attributes[key]);
            node.appendChild(tag);
        }
    },

    /**
     * Method: setState
     * OpenStreetMap has a convention that 'state' is stored for modification or deletion.
     * This allows the file to be uploaded via JOSM or the bulk uploader tool.
     *
     * Parameters:
     * feature - {<OpenLayers.Feature.Vector>}
     * node - {DOMNode}
     */
    setState: function(feature, node) {
        if (feature.state) {
            var state = null;
            switch(feature.state) {
                case OpenLayers.State.UPDATE:
                    state = "modify";
                case OpenLayers.State.DELETE:
                    state = "delete";
            }
            if (state) {
                node.setAttribute("action", state);
            }
        }
    },

    CLASS_NAME: "OpenLayers.Format.OSM"
});

/**
 * Function that parse a multypolygone. Use the roles inner and enclave
 * for inner border. all others will be consid??re as outer border.
 *
 * Parameters:
 * relation - {DOMElement} the relation to parse
 * parser - <OpenLayers.parser.OSM> the parser
 * nodes - {Array({DOMElement})} all the available nodes
 * ways - {Array({DOMElement})} all the available ways
 * relations - {Array({DOMElement})} all the available relations
 *
 * Returns:
 * {Array(<OpenLayers.Feature.Vector>)} a list of one element that represent the multypolygone
 */
OpenLayers.Format.OSM.multipolygonParser = function(relation, parser, nodes, ways, relations) {
    var lastRole = '';
    var lastPointList = [];
    var innerLignes = [];
    var outerLignes = [];

    for (var j = 0; j < relation.ways.length; j++) {
        var way = relation.ways[j]
        var ref = way.getAttribute("ref");
        var role = way.getAttribute("role");

        var pointList = parser.getPointList(ways[ref], nodes);
        if (pointList.length == 0) {
            continue;
        }
        var newPath = true;
        if (lastRole == '') {
            lastRole = role;
        }
        if (lastRole == role) {
            var result = parser.concatPathsIfLinear(lastPointList, pointList);
            if (result.succed) {
                newPath = false;
                lastPointList = result.lastPointList;
            }
        }

        if (newPath) {
            if (lastPointList.length > 0) {
                if (lastRole == 'inner' || lastRole == 'enclave') {
                    var geometry = new OpenLayers.Geometry.LinearRing(lastPointList)
                    innerLignes.push(geometry);
                }
                else { // if (lastRole == 'outer') {
                    var geometry = new OpenLayers.Geometry.LinearRing(lastPointList)
                    outerLignes.push(geometry);
                }
            }
            lastPointList = pointList;
            lastRole = role;
        }
    }
    if (lastPointList.length > 0) {
        if (lastRole == 'inner' || lastRole == 'enclave') {
            var geometry = new OpenLayers.Geometry.LinearRing(lastPointList)
            innerLignes.push(geometry);
        }
        else { // if (lastRole == 'outer') {
            var geometry = new OpenLayers.Geometry.LinearRing(lastPointList)
            outerLignes.push(geometry);
        }
    }

    var polygons = [];
    for (var j = 0 ; j < outerLignes.length ; j++) {
        if (innerLignes.length == 0) {
            polygons.push(new OpenLayers.Geometry.Polygon([outerLignes[j]]));
        }
        else {
            var currentInners = [];
            for (var k = 0 ; k < innerLignes.length ; k++) {
                var inner = innerLignes[k];
                if (outerLignes[j].containsPoint(inner.getCentroid())) {
                    currentInners.push(inner);
                }
            }
            polygons.push(new OpenLayers.Geometry.Polygon(
                    [outerLignes[j]].concat(currentInners)));
        }
    }
    var geometry = new OpenLayers.Geometry.MultiPolygon(polygons);
    var feat = new OpenLayers.Feature.Vector(geometry, relation.tags);
    feat.osm_id = parseInt(relation.id);
    feat.type = "relation";
    feat.fid = "relation." + feat.osm_id;
    return [feat];
},

/**
 * Function that convert all the ways of a relation into a LineStrings.
 *
 * Parameters:
 * relation - {DOMElement} the relation to parse
 * parser - <OpenLayers.parser.OSM> the parser
 * nodes - {Array({DOMElement})} all the available nodes
 * ways - {Array({DOMElement})} all the available ways
 *
 * Returns:
 * {Array(<OpenLayers.Geometry.LineString>)}
 */
OpenLayers.Format.OSM.getLineStrings = function(relation, parser, nodes, ways) {
    var geometries = [];
    for (var j = 0; j < relation.ways.length; j++) {
        var way = relation.ways[j]
        var ref = way.getAttribute("ref");

        // TODO considere to create some area
        var pointList = parser.getPointList(ways[ref], nodes);
        if (pointList.length == 0) {
            continue;
        }

        geometries.push(new OpenLayers.Geometry.LineString(pointList));
    }
    return geometries;
}

/**
 * Function that parse a route. All the inner ways will be converted into a MultiLineString.
 *
 * Parameters:
 * relation - {DOMElement} the relation to parse
 * parser - <OpenLayers.parser.OSM> the parser
 * nodes - {Array({DOMElement})} all the available nodes
 * ways - {Array({DOMElement})} all the available ways
 * relations - {Array({DOMElement})} all the available relations
 *
 * Returns:
 * {Array(<OpenLayers.Feature.Vector>)} a list of one element that represent the route.
 */
OpenLayers.Format.OSM.routeParser = function(relation, parser, nodes, ways, relations) {
    var geometries = OpenLayers.Format.OSM.getLineStrings(relation, parser, nodes, ways);
    var geometry = new OpenLayers.Geometry.MultiLineString(geometries);
    var feat = new OpenLayers.Feature.Vector(geometry, relation.tags);
    feat.osm_id = parseInt(relation.id);
    feat.type = "relation";
    feat.fid = "relation." + feat.osm_id;
    return [feat];
}

/**
 * Function that parse a relation. All inerr way will be converten into LineLtrings,
 * and all inner nodes into Points.
 *
 * Parameters:
 * relation - {DOMElement} the relation to parse
 * parser - <OpenLayers.parser.OSM> the parser
 * nodes - {Array({DOMElement})} all the available nodes
 * ways - {Array({DOMElement})} all the available ways
 * relations - {Array({DOMElement})} all the available relations
 *
 * Returns:
 * {Array(<OpenLayers.Feature.Vector>)} a lint of one element that represent the relation.
 */
OpenLayers.Format.OSM.genericParser = function(relation, parser, nodes, ways, relations) {
    var geometries = OpenLayers.Format.OSM.getLineStrings(relation, parser, nodes, ways);
    for (var j = 0; j < relation.nodes.length; j++) {
        var node = relation.nodes[j]
        geometries.push(new OpenLayers.Geometry.Node(node));
    }
    var geometry = new OpenLayers.Geometry.Collection(geometries);
    var feat = new OpenLayers.Feature.Vector(geometry, relation.tags);
    feat.osm_id = parseInt(relation.id);
    feat.type = "relation";
    feat.fid = "relation." + feat.osm_id;
    return [feat];
}

/**
 * Function that parse a route. All linear ways with the same role
 * will be converted into one LineString.
 *
 * Parameters:
 * relation - {DOMElement} the relation to parse
 * parser - <OpenLayers.parser.OSM> the parser
 * nodes - {Array({DOMElement})} all the available nodes
 * ways - {Array({DOMElement})} all the available ways
 * relations - {Array({DOMElement})} all the available relations
 *
 * Returns:
 * {Array(<OpenLayers.Feature.Vector>)} a list of linear LineString.
 */
OpenLayers.Format.OSM.routeParserWithRoles = function(relation, parser, nodes, ways, relations) {
    var geometries = [];
    var lastRole = '';
    var lastPointList = [];
    var features = [];

    for (var j = 0; j < relation.ways.length; j++) {
        var way = relation.ways[j]
        var ref = way.getAttribute("ref");
        var role = way.getAttribute("role");

        var pointList = parser.getPointList(ways[ref], nodes);
        if (pointList.length == 0) {
            continue;
        }
        var newPath = true;
        if (lastRole == '') {
            lastRole = role;
        }
        if (lastRole == role) {
            var result = parser.concatPathsIfLinear(lastPointList, pointList);
            if (result.succed) {
                newPath = false;
                lastPointList = result.lastPointList;
            }
        }
        if (newPath) {
            var geometry = new OpenLayers.Geometry.LineString(lastPointList)
            var feat = new OpenLayers.Feature.Vector(geometry, relation.tags);
            if (role) {
                feat.attributes.role = role;
            }
            feat.osm_id = parseInt(relation.id);
            feat.type = "relation";
            feat.fid = "relation." + feat.osm_id + "." + j;
            features.push(feat);
            lastPointList = pointList;
            lastRole = role;
        }
    }
    var geometry = new OpenLayers.Geometry.LineString(lastPointList)
    var feat = new OpenLayers.Feature.Vector(geometry, relation.tags);
    if (role) {
        feat.attributes.role = role;
    }
    feat.osm_id = parseInt(relation.id);
    feat.type = "relation";
    feat.fid = "relation." + feat.osm_id;
    features.push(feat);
    return features;
}
