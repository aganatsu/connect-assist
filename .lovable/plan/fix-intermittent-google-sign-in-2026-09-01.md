# Fix intermittent Google sign-in

## Problem
The backend completes Google login successfully, but the frontend can still treat the first `INITIAL_SESSION` event as a newer auth result. When that event is temporarily empty, it can suppress the valid stored session loaded moments later and leave the user on `/login`.

## Changes
- Make auth initialization distinguish the initial session notification from real sign-in/sign-out events, so an empty startup event cannot override a valid Google session.
- Add an explicit same-origin `/auth/callback` route that waits for session hydration and then redirects safely to the dashboard.
- Redirect authenticated users away from `/login` and `/signup`, covering successful OAuth returns even when navigation completes outside the original click handler.
- Increase resilience for the preview popup flow without changing email/password authentication.

## Validation
- Verify signed-out users still see login.
- Restore a valid session and verify `/login`, `/signup`, and `/auth/callback` all resolve to the authenticated dashboard.
- Check the build and browser console for auth-related errors.
