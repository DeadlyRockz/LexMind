/**
 * Every core test runs offline. `LEXMIND_OFFLINE=1` forces the replay adapter and turns any
 * attempted network call into a hard failure, so a test can never silently reach the Gemini API
 * and CI never needs a key.
 */
process.env['LEXMIND_OFFLINE'] = '1';
delete process.env['GEMINI_API_KEY'];
