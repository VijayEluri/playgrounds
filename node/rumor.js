var events = require('events'),
    argv = require('optimist').argv,
    fs = require('fs'),
    http = require('http'),
    sys = require('sys'),
    url = require('url'),
    urlparse = require('url').parse,
    log = require('log'),
    sprintf = require('./sprintf-0.6').sprintf
    BufferList = require('bufferlist').BufferList;

var cllog = console.log
var clinfo = console.log
var _reHref = /<a\s[^>]*href="([^"]+)"|<a\s[^>]*href='([^']+)'/img
var _reHref2 = /href=["'](.*)["']$/i

// ---- Configuration ----
var C = {
	"version": '0.0.1',
	"content.sizelimit": 1024 * 1024 * 4,
};

if (argv.parallel)
	argv.p = argv.parallel;
if (argv.name)
	argv.n = argv.name;
if (argv.timeout)
	argv.t = argv.timeout;

var fetcherTimeot = 10;
if (argv.t)
	fetcherTimeout = argv.t;

var slog, ulog;
if (argv.n) {
	slog = new log(log.INFO, fs.createWriteStream(argv.n + '-sites.log'));
	ulog = new log(log.INFO, fs.createWriteStream(argv.n + '-urls.log'));
} else {
	slog = new log(log.INFO, fs.createWriteStream('sites.log'));
	ulog = new log(log.INFO, fs.createWriteStream('urls.log'));
}

var clog = new log(log.INFO);

function logerror(name, error) {
	console.log(name);
	console.log(error);
	console.log(error.stack);
}

// ---- Entry ----
function Entry(url, referer) {
	this.url = url;
	this.referer = referer;

	this.parse = function() {
		if (!this.url)
			return this;
	
		var ui = urlparse(this.url);
		this.host = ui.host;
		this.port = ui.port;
		this.hostname = ui.hostname;
		this.protocol = ui.protocol;
		this.pathname = ui.pathname;

		if (this.pathname === undefined)
			this.pathname = '/';
		if (this.port === undefined)
			if (this.protocol === 'http:')
				this.port = 80;
			else if (this.protocol === 'https:')
				this.port = 443;
		return this;
	};
	this.parse();
};

// ---- Rumor ----
function Rumor(C) {
	events.EventEmitter.call(this);

	this.conf = C;
	this.entries = new Array;
	this.entriesMap = new Object;

	this.entriesLimit1 = 2500;
	this.entriesLimit2 = 5000;

	this.sites = new Object;
	this.fetchers = new Object;

	this.curFetcherId = 0;
	this.curFetchers = 0;
	this.curFetcherLimit = 250;

	this.lastSeeds = [];

	if (argv.p)
		this.curFetcherLimit = argv.p;

	this.curFinished = 0;
	this.curFinishedContent = 0;

	this.tickCount = 0;

	this.tick10S = function(self) {
		self.tickCount += 1;
		var slow = 0;
		var timeout = 0;

		for (var id in self.fetchers) {
			var fetcher = self.fetchers[id];
			if (self.tickCount - fetcher.beginTick < 3)
				continue;
			if (self.tickCount - fetcher.beginTick > fetcher.timeout) {
				fetcher.co.destroy();
				fetcher.clear();
				timeout ++;
			} else {
				slow ++;
			}
		}

		clog.info(sprintf("TICK:%d ID:%d - FETCHERS:%d SLOW:%d TIMEOUT:%d - ENTRIES:%d - FINISHED:%d CONTENT:%.1fm", 
			self.tickCount, self.curFetcherId, self.curFetchers, slow, timeout,
			self.entries.length, self.curFinished, self.curFinishedContent / 1048576.0));

		if (self.entries.length < 5) {
			for (var i =  0; i <  self.lastSeeds.length; i++) {
				self.entries.push(self.lastSeeds[i]);
			}
		}
		self.curFinished = 0;
		self.curFinishedContent = 0;
		self.fireFetchers();
	}

	this.tick10STimerId = setInterval(this.tick10S, 10000, this);

	this.pushSeed = function(ei) {
		this.lastSeeds.push(ei);
		if (this.lastSeeds.length > 20)
			this.lastSeeds.shift();
	}

	// ----
	this.genFetcherId = function() {
		this.curFetcherId ++;
		return this.curFetcherId;
	};

	// ----
	this.fireFetcher = function(entry) {
		var fetcher = new Fetcher(this, entry);
		this.addFetcher(fetcher);
		fetcher.fire();
		return fetcher;
	};

	this.fireFetchers = function() {
		while (true) {
			if (this.entries.length == 0)
				return;

			if (this.curFetchers >= this.curFetcherLimit) {
				return;
			}

			var ei = this.entries.shift();
			delete this.entriesMap[ei.url];
			if (this.sites[ei.hostname] && this.sites[ei.hostname] > 8)
				continue;

			this.fireFetcher(ei);
		}
	};

	// ----
	this.addEntry = function(entry) {
		if (this.entriesMap[entry.url] !== undefined)
			return;

		this.entriesMap[entry.url] = entry;
		this.entries.push(entry);
	};

	// ----
	this.insertEntry = function(entry) {
		if (this.entriesMap[entry.url] !== undefined)
			return;
		this.entriesMap[entry.url] = entry;
		this.entries.unshift(entry);
	};

	// ----
	this.addFetcher = function(task) {
		if (task.registered)
			return;

		this.curFetchers ++;
		this.fetchers[task.id] = task;

		// Add to sites map
		var sites = this.sites;
		if (sites[task.entry.host] != undefined)
			sites[task.entry.host] += 1;
		else {
			slog.info(task.entry.host + " == " + task.entry.referer);
			sites[task.entry.host] = 1;
		}

		task.registered = true;
	};

	// ----
	this.removeFetcher = function(task) {
		if (!task.registered)
			return;

		this.curFetchers --;
		delete this.fetchers[task.id];

		// Remove from sites
		var sites = this.sites;
		if (sites[task.entry.host] != undefined) {
			sites[task.entry.host] -= 1;
			if (sites[task.entry.host] <= 0)
				delete sites[task.entry.host];
		}
			
		task.registered = false;
	};

	this.onFetcherFinished = function(fetcher) {
		this.curFinished ++;
		if (fetcher.content)
			this.curFinishedContent += fetcher.content.length;
		this.planner.onFetcherFinished(fetcher);
	};

	// ----
	this.version = function() {
		return C.version;
	};

	this.tagline = function() { 
		clinfo("Rumor -- " + this.version());
	};
};
sys.inherits(Rumor, events.EventEmitter);

// ---- Fetcher ----
function Fetcher(R, ei) {
	this.rumor = R;
	this.entry = ei;
	this.id = R.genFetcherId();
	this.beginTick = this.rumor.tickCount;
	this.registered = false;
	this.timeout = fetcherTimeout;

	if (this.entry.contentSizeLimit)
		this.contentSizeLimit = this.entry.contentSizeLimit;
	else
		this.contentSizeLimit = this.rumor.conf['content.sizelimit'];

	this.fire = function() {
		var self = this;
		this.co = http.createClient(this.entry.port, this.entry.hostname);

		this.co.on('close', function(error) {
			self.clear();
		});

		this.co.on('error', function(error) {
			// ignore error, and 'close' will be emitted.
		});

		var headers = {};
		headers.host = this.entry.host;
		headers.agent = 'rumor-' + this.rumor.version() + " http://github.com/is/Demos/blob/master/node/rumor.js";

		if (this.entry.referer)
			headers.referer = this.entry.referer;

		this.request = this.co.request('GET', this.entry.pathname, headers);
		this.request.on('response', function(response) { 
			self.onResponse(response);
		});
		this.request.on('error', function(exception) { 
			self.onRequestError(exception)
		});
		this.request.end();
	};

	this.onResponse = function(response) {
		var self = this;
		this.response = response;
		this.retCode = response.statusCode;

		if (this.retCode != 200) {
			this.finished();
			return;
		}

		this.content = new BufferList;
		response.on('data', function(chunk) { self.onResponseData(chunk); }).
			on('error', function(exception) { self.onResponseError(exception); }).
			on('end', function() { self.onResponseEnd(); });
	};

	this.onResponseData = function(chunk) {
		this.content.push(chunk);
		if (this.contentSizeLimit) {
			if (this.content.length > this.contentSizeLimit) {
				this.onResponseError('too-big-contents');
			}
		}
	};

	this.onRequestError = function(error) {
		logerror('onRequestError', error);
		this.clear();
		this.co.destroy();
	};

	this.onResponseError = function(error) {
		// logerror('onResponseError', error);
		this.clear();
		this.response.client.destroy();
	};

	this.onResponseEnd = function() {
		this.finished();
	};

	this.clear = function() {
		this.rumor.removeFetcher(this);
	};

	this.finished = function() {
		this.clear();
		this.rumor.onFetcherFinished(this);
	};
};

// ---- 
function Planner(rumor) {
	this.rumor = rumor;
	this.onFetcherFinished = function(fetcher) {
		if (!fetcher.entry.referer)
			fetcher.entry.referer = "{empty}"

		var retCode = fetcher.retCode;
		if (retCode == 301 || retCode == 302 || retCode == 307) {
			this.onRedirect(fetcher);
			return;
		}

		if (retCode == 200) {
			this.onContent(fetcher);
			return;
		}
		
		ulog.info("[" + fetcher.retCode + "] " + fetcher.entry.url + " == " + fetcher.entry.referer);
		return;
	};

	this.onContent = function(fetcher) {
		if (!fetcher.content && !fetcher.content.length) {
			return;
		}

		var contentType = fetcher.response.headers['content-type'];
		var contentLength = fetcher.response.headers['content-length'];

		if (!contentType)
			contentType = "-";

		if (!contentLength)
			contentLength = fetcher.content.length;

		var accu = rumor.entries.length;
		ulog.info("[200] " + fetcher.entry.url + " == " + fetcher.entry.referer + " {" + contentLength + ":"+ contentType + "} <" + fetcher.id + "/" + (this.rumor.tickCount - fetcher.beginTick) + ">");

		if (accu >= rumor.entriesLimit2) {
			return;
		}

		if (contentType.search("text/html") == -1)
			return;

		var self = this;

		var entries = [];
		var entriesMap = {};

		var linktags = fetcher.content.toString().match(_reHref);
		if (linktags) {
			for (var i = 0; i < linktags.length; i++) {
				var res = _reHref2.exec(linktags[i]);
				if (!res)
					continue;
				var u = url.resolve(fetcher.entry.url, res[1]);
				var e = new Entry(u, fetcher.entry.url);
				if (e.protocol === 'http:') {
					if (!entriesMap[u]) {
						entries.push(e);
						entriesMap[u] = 1;
					}
				}
			}
		}

		/*
		var handler = new htmlparser.DefaultHandler();
		var parser = new htmlparser.Parser(handler);
		try {
			parser.parseComplete(fetcher.content);
		} catch(e) {
			return;
		}
		
		linktags = htmlparser.DomUtils.getElementsByTagName('a', handler.dom);
	
		for (var i = 0; i < linktags.length; i++) {
			var l = linktags[i];
			if (!l.attribs || !l.attribs.href)
				continue;
			href = l.attribs.href;
			var u = url.resolve(fetcher.entry.url, href);
			var e = new Entry(u, fetcher.entry.url);
			if (e.protocol === 'http:') {
				if (!entriesMap[u]) {
					entries.push(e);
					entriesMap[u] = 1;
				}
			}
		}
		*/

		if (entries.length > 40) {
			rumor.pushSeed(this.entry);
		}

		var added = entries.length
		if (accu >= rumor.entriesLimit1 && added > 30) {
			added = 15;
		}

		var swapper = function(a, L, e) {
			var r = Math.floor(Math.random() * L);
			var x = a[e];
			a[e] = a[r];
			a[r] = a[e];
		};

		for (var i = 0, L = entries.length; i < added; i++)
			swapper(entries, L, i);

		for (var i = 0; i < added; i++) {
			if (entries[i].protocol === "http:")
				if (entries[i].hostname === fetcher.entry.hostname)
					rumor.addEntry(entries[i]);
				else
					rumor.insertEntry(entries[i]);
		}

		rumor.fireFetchers();
	};

	this.onRedirect = function(fetcher) {
		var redirectURL = fetcher.response.headers['location'];
		if (!redirectURL)
			return;

		redirectURL = url.resolve(fetcher.entry.url, redirectURL);
		// cllog("[" + fetcher.retCode + "] " + fetcher.entry.url + " -> " + redirectURL);
		this.addEntry(redirectURL, fetcher.entry.referer, true);
	};


	this.addEntry = function(url, referer, fire) {
		var e = new Entry(url, referer);
		if (e.protocol === 'http:') {
			rumor.addEntry(e);
		}
		if (fire) {
			rumor.fireFetchers();
		}
	};
}

// ---- Main ----
function main() {
	var r = new Rumor(C);
	r.planner = new Planner(r);
	r.tagline();
	var ei = new Entry('http://freshmeat.net/');
	r.fireFetcher(ei);
}

main();


process.on('exit', function() {
	console.log('--- END ---');
});

process.on('uncaughtException', function(err) {
	console.log('--- EXCEPTION --- ' + err);
	console.log(err.stack);
});

/*
process.on('SIGINT', function() {
	console.log('--- Got SIGINT. Press Control-D to exit.');
});
*/
