// Site-wide settings that apply to every visitor (published with the site).
// When clientId is filled in, signing in with Google is REQUIRED before the dashboard opens.
//   clientId     : Google OAuth Client ID (not a secret; ends with .apps.googleusercontent.com)
//   allowHash    : SHA-256 of each allowed e-mail (lower case), so the addresses are not readable in
//                  this public file; empty = any Google account added as a test user in Google Cloud
//   rememberDays : how long a device stays signed in (lets the tablet work offline in the plant)
const SITE={
  clientId:'',
  allow:[],
  allowHash:['fc44c042ee076d206b30b9b81ff2b19a1ae2b982e9dd683fcfbf1bdbb9b72f38'],
  rememberDays:30,
};
