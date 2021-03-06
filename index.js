var mastodon = require('mastodon');
var pg = require('pg');

var DB_USER = process.env.DB_USER || 'ambassador';
var DB_NAME = process.env.DB_NAME || 'mastodon_production';
var DB_PASSWORD = process.env.DB_PASSWORD || '';
var DB_HOST = process.env.DB_HOST || '/var/run/postgresql';
var AMBASSADOR_TOKEN = process.env.AMBASSADOR_TOKEN;
var INSTANCE_HOST = process.env.INSTANCE_HOST;
var BOOSTS_PER_CYCLE = process.env.BOOSTS_PER_CYCLE || 2;
var THRESHOLD_INTERVAL_DAYS = process.env.THRESHOLD_INTERVAL_DAYS || 30;
var BOOST_MAX_DAYS = process.env.BOOST_MAX_DAYS || 5;
var THRESHOLD_CHECK_INTERVAL = process.env.THRESHOLD_CHECK_INTERVAL || 15; // cycles
var CYCLE_INTERVAL = process.env.CYCLE_INTERVAL || 15; // minutes
var BOOST_MIN_HOURS = process.env.BOOST_MIN_HOURS || 12;
var THRESHOLD_NUMERATOR = process.env.THRESHOLD_NUMERATOR || 1;
var THRESHOLD_DENOMINATOR = process.env.THRESHOLD_DENOMINATOR || 1;
var USER_BOOST_LIMIT = process.env.USER_BOOST_LIMIT || 3;
var USER_BOOST_INTERVAL_HOURS = process.env.USER_BOOST_INTERVAL_HOURS || 24;

var config = {
  user: process.env.DB_USER || 'ambassador',
  database: process.env.DB_NAME || 'mastodon_production',
  password: process.env.DB_PASSWORD || '',
  host: process.env.DB_HOST || '/var/run/postgresql',
  port: 5432, //env var: PGPORT
  max: 2, // max number of clients in the pool
  idleTimeoutMillis: 30000 // how long a client is allowed to remain idle before being closed
};

// Define our threshold (average faves over the past x days)
var thresh_query = `SELECT ceil(avg(favourites_count)) AS threshold
  FROM public_toots
  WHERE
    favourites_count > 1
    AND updated_at > NOW() - INTERVAL '` + THRESHOLD_INTERVAL_DAYS + ` days'`

// Find all toots we haven't boosted yet, but ought to
// sub-query 1:
// have we boosted this already?
// sub-query 2:
// if we look at how many statuses we've boosted from a given account over
// the past n hours, is that number greater than three?

var query = `SELECT public_toots.id
  FROM public_toots
  WHERE
    favourites_count >= ceil($1)
    AND NOT EXISTS (
      SELECT 1
      FROM public_toots AS pt2
      WHERE
        pt2.reblog_of_id = public_toots.id
        AND pt2.account_id = $2
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT pt3.account_id, count(*) AS count
        FROM public_toots pt3, public_toots
        WHERE
          pt3.id = public_toots.reblog_of_id
          AND public_toots.account_id = $2
          AND public_toots.updated_at > NOW() - INTERVAL '` + USER_BOOST_INTERVAL_HOURS + ` hours'
        GROUP BY pt3.account_id
      ) AS dt, public_toots AS pt4
      WHERE
        dt.count > ` + USER_BOOST_LIMIT + `
        AND dt.account_id = pt4.account_id
    )
    AND updated_at > NOW() - INTERVAL '` + BOOST_MAX_DAYS + ` days'
    AND updated_at < NOW() - INTERVAL '` + BOOST_MIN_HOURS + ` hours'
  ORDER BY favourites_count DESC
  LIMIT $3`

console.dir('STARTING AMBASSADOR');
console.log('\tDB_USER:', DB_USER);
console.log('\tDB_NAME:', DB_NAME);
console.log('\tDB_PASSWORD:', DB_PASSWORD.split('').map(function() { return "*" }).join(''));
console.log('\tDB_HOST:', DB_HOST);
console.log('\tAMBASSADOR_TOKEN:', AMBASSADOR_TOKEN);
console.log('\tINSTANCE_HOST:', INSTANCE_HOST);
console.log('\tBOOSTS_PER_CYCLE:', BOOSTS_PER_CYCLE);
console.log('\tTHRESHOLD_INTERVAL_DAYS:', THRESHOLD_INTERVAL_DAYS);
console.log('\tBOOST_MAX_DAYS:', BOOST_MAX_DAYS);
console.log('\tTHRESHOLD_CHECK_INTERVAL:', THRESHOLD_CHECK_INTERVAL);
console.log('\tCYCLE_INTERVAL:', CYCLE_INTERVAL);
console.log('\tUSER_BOOST_LIMIT:', USER_BOOST_LIMIT);
console.log('\tUSER_BOOST_INTERVAL_HOURS:', USER_BOOST_INTERVAL_HOURS);

var g_threshold_downcount = 0;
var g_threshold = 0;

function getThreshold(client, f) {
  if (g_threshold_downcount <= 0 || g_threshold <= 0) {
    console.log('Threshold is stale, recalculating...');
    client.query(thresh_query, [], function (err, result) {
      if (err) {
        throw "error running threshold query: " + err;
      }

      g_threshold = result.rows[0].threshold * THRESHOLD_NUMERATOR / THRESHOLD_DENOMINATOR;
      g_threshold_downcount = THRESHOLD_CHECK_INTERVAL;
      return f(g_threshold);
    });
  } else {
    g_threshold_downcount--;
    console.log('Cycles until next threshold update: ' + g_threshold_downcount);
    return f(g_threshold);
  }
}

function cycle() {
  console.log('Cycle beginning');
  var client = new pg.Client(config);

  client.connect(function (err) {
    if (err) {
      console.error('error connecting to client');
      return console.dir(err);
    }

    whoami(function (account_id) {
      getThreshold(client, function (threshold) {
        console.log('Current threshold: ' + threshold);
        if (threshold < 1) {
          throw "threshold too low: " + threshold;
        }

        client.query(query, [threshold, account_id, BOOSTS_PER_CYCLE], function (err, result) {
          if (err) {
            throw "error running toot query: " + err;
          }

          client.end(function (err) {
            if (err) {
              throw "error disconnecting from client: " + err;
            }
          });

          boost(result.rows);
          console.log('Cycle complete');
        });
      });
    })
  });
}

var M = new mastodon({
  access_token: AMBASSADOR_TOKEN,
  api_url: INSTANCE_HOST + '/api/v1'
});

function whoami(f) {
  M.get('/accounts/verify_credentials', function(err, result) {
    if (err) {
      console.error('error getting current user id');
      throw err;
    }
    if (result.id === undefined) {
      console.error('verify_credentials result is undefined');
      throw "verify_credentials failed";
    }
    console.log('Authenticated as ' + result.id + ' (' + result.display_name + ')');
    return f(result.id);
  })
}

function boost(rows) {
  rows.forEach(function(row) {
    console.log('boosting status #' + row.id);
    M.post('/statuses/' + row.id + '/reblog', function(err, result) {
      if (err) {
        if (err.message === 'Validation failed: Reblog of status already exists') {
          return console.log('Warning: tried to boost #' + row.id + ' but it had already been boosted by this account.');
        }

        if (err.message === 'This action is not allowed') {
          return console.log('Warning: tried to boost #' + row.id + ' but the action was not allowed.');
        }

        return console.log(err);
      }
    });
  })
}

cycle();
setInterval(cycle, 1000 * 60 * CYCLE_INTERVAL);
