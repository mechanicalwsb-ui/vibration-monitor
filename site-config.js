// Site-wide settings that apply to every visitor (published with the site).
// When clientId is filled in, signing in with Google is REQUIRED before the dashboard opens.
//   clientId     : Google OAuth Client ID (not a secret; ends with .apps.googleusercontent.com)
//   allow        : e-mail addresses allowed to sign in; empty = any Google account added as a test user
//   rememberDays : how long a device stays signed in (lets the tablet work offline in the plant)
const SITE={
  clientId:'',
  allow:[],
  rememberDays:30,
};
