var util = require('util')
var OAuth2Strategy = require('passport-oauth2')
var InternalOAuthError = require('passport-oauth2').InternalOAuthError;

var liteProfileUrl = 'https://api.linkedin.com/v2/me?projection=(' +
  'id,' +
  'firstName,' +
  'lastName,' +
  'profilePicture(displayImage~:playableStreams)' +
  ')';

// Most of these fields are only available for members of partner programs.
var basicProfileUrl = 'https://api.linkedin.com/v2/me?projection=(' +
  'id,' +
  'firstName,' +
  'lastName,' +
  'maidenName,' +
  'headline,' +
  'profilePicture(displayImage~:playableStreams),' +
  'vanityName' +
  ')';

// Full profile fields
var fullProfileUrl = 'https://api.linkedin.com/v2/me?projection=(' +
  'id,' +
  'address,' +
  'backgroundPicture(displayImage~digitalmediaAsset:playableStreams),' +
  'birthDate,' +
  'certifications,' +
  'courses,' +
  'educations,' +
  'firstName,' +
  'geoLocation,' +
  'headline,' +
  'honors,' +
  'industryId,' +
  'industryName,' +
  'lastName,' +
  'lastModified,' +
  'maidenName,' +
  'organizations,' +
  'patents,' +
  'phoneNumbers,' +
  'phoneticFirstName,' +
  'phoneticLastName,' +
  'positions,' +
  'profilePicture(displayImage~:playableStreams),' +
  'projects,' +
  'publications,' +
  'skills,' +
  'summary,' +
  'testScores,' +
  'vanityName,' +
  'volunteeringExperiences,' +
  'volunteeringInterests,' +
  'websites' +
  ')';

function Strategy(options, verify) {
  options = options || {};
  options.authorizationURL = options.authorizationURL || 'https://www.linkedin.com/oauth/v2/authorization';
  options.tokenURL = options.tokenURL || 'https://www.linkedin.com/oauth/v2/accessToken';
  options.scope = options.scope || ['r_liteprofile'];

  //By default we want data in JSON
  options.customHeaders = options.customHeaders || {"x-li-format":"json", "X-Restli-Protocol-Version": "2.0.0"};

  OAuth2Strategy.call(this, options, verify);

  this.options = options;
  this.name = 'linkedin';
  if (options.scope.indexOf('r_fullprofile') !== -1) {
      this.profileUrl = fullProfileUrl;
  } else if (options.scope.indexOf('r_basicprofile') !== -1) {
      this.profileUrl = basicProfileUrl;
  } else {
      this.profileUrl = liteProfileUrl;
  }

  this.emailUrl = 'https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))';
}

util.inherits(Strategy, OAuth2Strategy);

Strategy.prototype.userProfile = function(accessToken, done) {
  //LinkedIn uses a custom name for the access_token parameter
  this._oauth2.setAccessTokenName("oauth2_access_token");

  this._oauth2.get(this.profileUrl, accessToken, function (err, body, res) {
    if (err) {
      return done(new InternalOAuthError('failed to fetch user profile', err));
    }

    var profile;

    try {
      profile = parseProfile(body);
    } catch(e) {
      return done(new InternalOAuthError('failed to parse profile response', e));
    }

    var loadedGeo = false;
    var loadedEmail = false;
    var cbCalledWithError = false;

    var geoUrl = getGeoLocationApiUrl(profile)
    if (geoUrl.length > 0) {
      this._oauth2.get(geoUrl, accessToken, function (err, body, res) {
        if (err) {
          return done(new InternalOAuthError('failed to fetch geo location', err));
        }
        loadedGeo = true;
        try {
          addGeoLocation(profile, body);
          if (loadedEmail) {
            return done(null, profile);
          }
        } catch(e) {
          if (!cbCalledWithError) {
            cbCalledWithError = true;
            return done(new InternalOAuthError('failed to parse geo location response', e));
          }
        }
      }.bind(this));
    } else {
        loadedGeo = true;
    }

    if (this.options.scope.includes('r_emailaddress')) {
      this._oauth2.get(this.emailUrl, accessToken, function (err, body, res) {
        if (err) {
          return done(new InternalOAuthError('failed to fetch user email', err));
        }

        loadedEmail = true;
        try {
          addEmails(profile, body);
          if (loadedGeo) {
            return done(null, profile);
          }
        } catch(e) {
          if (!cbCalledWithError) {
            cbCalledWithError = true;
            return done(new InternalOAuthError('failed to parse email response', e));
          }
        }
      }.bind(this));
    } else {
        loadedEmail = true;
    }
    if (loadedGeo && loadedEmail) {
      done(null, profile);
    }

  }.bind(this));
}

Strategy.prototype.authorizationParams = function(options) {
  var params = {};

  // LinkedIn requires state parameter. It will return an error if not set.
  if (options.state) {
    params['state'] = options.state;
  }

  return params;
}

function getName(nameObj) {
  var locale = nameObj.preferredLocale.language + '_' + nameObj.preferredLocale.country;
  return nameObj.localized[locale];
}

function getProfilePictures(profilePictureObj) {
  // This is the format we used to return in the past.
  var result = [];

  if(!profilePictureObj) {
    // Picture is optional.
    return result;
  }

  try {
    profilePictureObj['displayImage~'].elements.forEach(function(pic) {
      // We keep only public profile pictures.
      if(pic.authorizationMethod !== 'PUBLIC') {
        return;
      }

      // This should not happen, but...
      if(pic.identifiers.length === 0) {
        return;
      }

      var url = pic.identifiers[0].identifier;

      result.push({ value: url });
    });
  } catch(e) {
    // Profile picture object changed format?
    return result;
  }

  return result;
}

function parseProfile(body) {
  var json = JSON.parse(body);

  var profile = { provider: 'linkedin' };

  profile.id = json.id;

  profile.name = {
    givenName: getName(json.firstName),
    familyName: getName(json.lastName)
  };

  profile.displayName = profile.name.givenName + ' ' + profile.name.familyName;

  profile.photos = getProfilePictures(json.profilePicture);

  profile._raw = body;
  profile._json = json;

  return profile;
}

function addEmails(profile, body) {
  var json = JSON.parse(body);

  if(json.elements && json.elements.length > 0) {
    profile.emails = json.elements.reduce(function (acc, el) {
      if (el['handle~'] && el['handle~'].emailAddress) {
        acc.push({
          value: el['handle~'].emailAddress
        });
      }
      return acc;
    }, []);
  }

  profile._emailRaw = body;
  profile._emailJson = json;
}

function addGeoLocation(profile, body) {
  var json = JSON.parse(body);
  profile.geoLocation = json.defaultLocalizedName.value;
  profile._geoRaw = body;
  profile._geoJson = json;
}

function getGeoLocationApiUrl(profile) {
  var url = "";
  var geoLocation = profile._json.geoLocation;
  if (geoLocation != undefined && geoLocation.geo != undefined) {
    var parts = geoLocation.geo.split(":");
    if (parts.length == 4) {
      url = "https://api.linkedin.com/v2/geo/"+parts[3];
    }
  }
  return url;
}

module.exports = Strategy;
