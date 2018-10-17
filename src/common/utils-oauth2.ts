'use strict';

import { OidcProfile, WickedApiScopes, WickedUserInfo, WickedPool, Callback, WickedSubscriptionInfo, WickedApi } from "wicked-sdk";
import { WickedApiScopesCallback, AuthRequest, SubscriptionValidationCallback, ValidatedScopes, TokenRequest, SimpleCallback, AccessTokenCallback, AuthResponse, SubscriptionValidation, OAuth2Request, AccessToken } from "./types";

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('portal-auth:utils-oauth2');
import * as wicked from 'wicked-sdk';
const request = require('request');

import { failMessage, failError, failOAuth, makeError, makeOAuthError } from './utils-fail';
import { profileStore } from './profile-store';

import { utils } from './utils';
import { oauth2 } from '../kong-oauth2/oauth2';

export class UtilsOAuth2 {

    constructor() {
        debug(`UtilsOAuth2()`);
    }

    private _apiScopes: { [apiId: string]: WickedApiScopes } = {};
    public getApiScopes = async (apiId: string) => {
        debug(`getApiScopes(${apiId})`);
        const instance = this;
        // Check cache first
        if (this._apiScopes[apiId])
            return this._apiScopes[apiId];
        debug('getApiScopes: Not present in cache, fetching.');
        const apiInfo = await wicked.getApi(apiId) as WickedApi;
        if (!apiInfo || !apiInfo.settings)
            throw new Error(`API ${apiId} does not have settings section`);
        debug('getApiScopes: Succeeded, storing.');
        debug('api.settings.scopes: ' + JSON.stringify(apiInfo.settings.scopes));
        instance._apiScopes[apiId] = apiInfo.settings.scopes || {};
        return instance._apiScopes[apiId];
    };

    public validateAuthorizeRequest = async (authRequest: AuthRequest): Promise<SubscriptionValidation> => {
        const instance = this;
        debug(`validateAuthorizeRequest(${authRequest})`);
        if (authRequest.response_type !== 'token' &&
            authRequest.response_type !== 'code')
            throw makeError(`Invalid response_type ${authRequest.response_type}`, 400);
        if (!authRequest.client_id)
            throw makeError('Invalid or empty client_id.', 400);
        if (!authRequest.redirect_uri)
            throw makeError('Invalid or empty redirect_uri', 400);
        const subsValidation = await instance.validateSubscription(authRequest);
        const application = subsValidation.subsInfo.application;
        if (!application.redirectUri)
            throw makeError('The application associated with the given client_id does not have a registered redirect_uri.', 400);

        // Verify redirect_uri from application, has to match what is passed in
        const uri1 = utils.normalizeRedirectUri(authRequest.redirect_uri);
        const uri2 = utils.normalizeRedirectUri(subsValidation.subsInfo.application.redirectUri);

        if (uri1 !== uri2) {
            error(`Expected redirect_uri: ${uri2}`);
            error(`Received redirect_uri: ${uri1}`);
            throw makeError('The provided redirect_uri does not match the registered redirect_uri', 400);
        }

        // Now we have a redirect_uri; we can now make use of failOAuth
        // Check for PKCE for public apps using the authorization code grant
        if (authRequest.response_type === 'code' &&
            application.confidential !== true) {
            if (!authRequest.code_challenge)
                throw makeOAuthError(400, 'invalid_request', 'the given client is a public client; it must present a code_challenge (PKCE, RFC7636) to use the authorization code grant.');
            if (!authRequest.code_challenge_method)
                authRequest.code_challenge_method = 'plain'; // Default
            if (authRequest.code_challenge_method !== 'plain' &&
                authRequest.code_challenge_method !== 'S256')
                throw makeOAuthError(400, 'invalid_request', 'unsupported code_challenge_method; expected "plain" or "S256".');
        }

        // Success
        return subsValidation;
    };

    public validateSubscription = async (oauthRequest: OAuth2Request): Promise<SubscriptionValidation> => {
        debug('validateSubscription()');
        try {
            const subsInfo = await wicked.getSubscriptionByClientId(oauthRequest.client_id, oauthRequest.api_id) as WickedSubscriptionInfo;
            // Do we have a trusted subscription?
            let trusted = false;
            if (subsInfo.subscription && subsInfo.subscription.trusted) {
                debug('validateAuthorizeRequest: Trusted subscription detected.');
                // Yes, note that in the authRequest
                trusted = true;
            }
            if (!subsInfo.application || !subsInfo.application.id)
                throw makeOAuthError(500, 'server_error', 'Subscription information does not contain a valid application id');

            oauthRequest.app_id = subsInfo.application.id;
            oauthRequest.app_name = subsInfo.application.name;
            const returnValues: SubscriptionValidation = {
                subsInfo: subsInfo,
                trusted: trusted,
            };

            return returnValues; // All's good for now
        } catch (err) {
            throw makeOAuthError(400, 'invalid_request', 'could not validate client_id and API subscription', err);
        }
    };

    public validateApiScopes = async (apiId: string, scope: string, subIsTrusted: boolean): Promise<ValidatedScopes> => {
        debug(`validateApiScopes(${apiId}, ${scope})`);

        const instance = this;
        const apiScopes = await instance.getApiScopes(apiId);
        // const apiInfo = await utils.getApiInfoAsync(apiId);

        let requestScope = scope;
        if (!requestScope) {
            debug('validateApiScopes: No scopes requested.');
            requestScope = '';
        }

        let scopes = [] as string[];
        if (requestScope) {
            if (requestScope.indexOf(' ') > 0)
                scopes = requestScope.split(' ');
            else if (requestScope.indexOf(',') > 0)
                scopes = requestScope.split(',');
            else if (requestScope.indexOf(';') > 0)
                scopes = requestScope.split(';')
            else
                scopes = [requestScope];
            debug(scopes);
        } else {
            scopes = [];
        }
        const validatedScopes = [] as string[];
        // Pass upstream if we changed the scopes (e.g. for a trusted application)
        let scopesDiffer = false;
        if (!subIsTrusted) {
            debug('validateApiScopes: Non-trusted subscription.');
            for (let i = 0; i < scopes.length; ++i) {
                const thisScope = scopes[i];
                if (!apiScopes[thisScope])
                    throw makeError(`Invalid or unknown scope "${thisScope}".`, 400);
                validatedScopes.push(thisScope);
            }
        } else {
            debug('validateApiScopes: Trusted subscription.');
            // apiScopes is a map of scopes
            for (let aScope in apiScopes) {
                validatedScopes.push(aScope);
            }
            scopesDiffer = true;
        }
        debug(`validated Scopes: ${validatedScopes}`);

        return {
            scopesDiffer: scopesDiffer,
            validatedScopes: validatedScopes
        };
    };

    public makeTokenRequest(req, apiId: string, authMethodId: string): TokenRequest {
        // Gather parameters from body. Note that not all parameters
        // are used in all flows.
        const tokenRequest = {
            api_id: apiId,
            auth_method: req.app.get('server_name') + ':' + authMethodId,
            grant_type: req.body.grant_type,
            code: req.body.code,
            //redirect_uri: req.body.redirect_uri,
            client_id: req.body.client_id,
            client_secret: req.body.client_secret,
            scope: req.body.scope,
            username: req.body.username,
            password: req.body.password,
            refresh_token: req.body.refresh_token,
            // PKCE
            code_verifier: req.body.code_verifier
        };
        if (!tokenRequest.client_id) {
            // Check for Basic Auth
            const authHeader = req.get('Authorization');
            if (authHeader) {
                let basicAuth = authHeader;
                if (authHeader.toLowerCase().startsWith('basic')) {
                    const spacePos = authHeader.indexOf(' ');
                    basicAuth = authHeader.substring(spacePos + 1);
                }
                // Try to decode base 64 to get client_id and client_secret
                try {
                    const idAndSecret = utils.decodeBase64(basicAuth);
                    // client_id:client_secret
                    const colonIndex = idAndSecret.indexOf(':');
                    if (colonIndex > 0) {
                        tokenRequest.client_id = idAndSecret.substring(0, colonIndex);
                        tokenRequest.client_secret = idAndSecret.substring(colonIndex + 1);
                    } else {
                        warn('makeTokenRequest: Received invalid client_id and client_secret in as Basic Auth')
                    }
                } catch (err) {
                    error('Received Basic Auth credentials, but they are invalid')
                    error(err);
                }
            }
        }

        return tokenRequest;
    };

    public validateTokenRequest = async (tokenRequest: TokenRequest) => {
        debug(`validateTokenRequest(${tokenRequest})`);

        if (!tokenRequest.grant_type)
            throw makeOAuthError(400, 'invalid_request', 'grant_type is missing.');

        // Different for different grant_types
        if (tokenRequest.grant_type === 'client_credentials') {
            if (!tokenRequest.client_id)
                throw makeOAuthError(400, 'invalid_client', 'client_id is missing.');
            if (!tokenRequest.client_secret)
                throw makeOAuthError(400, 'invalid_client', 'client_secret is missing.');
            return;
        } else if (tokenRequest.grant_type === 'authorization_code') {
            if (!tokenRequest.code)
                throw makeOAuthError(400, 'invalid_request', 'code is missing.');
            if (!tokenRequest.client_id)
                throw makeOAuthError(400, 'invalid_client', 'client_id is missing.');
            if (!tokenRequest.client_secret && !tokenRequest.code_verifier)
                throw makeOAuthError(400, 'invalid_client', 'client_secret or code_verifier is missing.');
        } else if (tokenRequest.grant_type === 'password') {
            if (!tokenRequest.client_id)
                throw makeOAuthError(400, 'invalid_client', 'client_id is missing.');
            // For confidential clients, the client_secret will also be checked (by the OAuth2 adapter)
            if (!tokenRequest.username)
                throw makeOAuthError(400, 'invalid_request', 'username is missing.');
            if (!tokenRequest.username)
                throw makeOAuthError(400, 'invalid_request', 'password is missing.');
            // TODO: scopes
        } else if (tokenRequest.grant_type === 'refresh_token') {
            if (!tokenRequest.client_id)
                throw makeOAuthError(400, 'invalid_client', 'client_id is missing.');
            // For confidential clients, the client_secret will also be checked (by the OAuth2 adapter)
            if (!tokenRequest.refresh_token)
                throw makeOAuthError(400, 'invalid_request', 'refresh_token is missing.');
        } else {
            throw makeOAuthError(400, 'unsupported_grant_type', `The grant_type '${tokenRequest.grant_type}' is not supported or is unknown.`);
        }
        return;
    };

    public tokenClientCredentials = async (tokenRequest: TokenRequest): Promise<AccessToken> => {
        debug('tokenClientCredentials()');
        const instance = this;
        const validationResult = await instance.validateSubscription(tokenRequest);
        const scopeInfo = await instance.validateApiScopes(tokenRequest.api_id, tokenRequest.scope, validationResult.trusted);
        tokenRequest.scope = scopeInfo.validatedScopes;
        // We can just pass this on to the wicked SDK.
        return await oauth2.tokenAsync(tokenRequest);
    };

    public tokenAuthorizationCode = async (tokenRequest: TokenRequest): Promise<AccessToken> => {
        const instance = this;
        return new Promise<AccessToken>(function (resolve, reject) {
            instance.tokenAuthorizationCode_(tokenRequest, function (err, accessToken) {
                err ? reject(err) : resolve(accessToken);
            })
        });
    }

    private tokenAuthorizationCode_ = (tokenRequest: TokenRequest, callback: AccessTokenCallback) => {
        debug('tokenAuthorizationCode()');
        profileStore.retrieve(tokenRequest.code, (err, profile) => {
            if (err)
                return callback(err);
            if (!profile)
                return callback(makeOAuthError(500, 'server_error', 'could not retrieve user profile for given authorization code'));
            tokenRequest.code_challenge = profile.code_challenge;
            tokenRequest.code_challenge_method = profile.code_challenge_method;
            delete profile.code_challenge;
            delete profile.code_challenge_method;
            // We can just pass this on to the wicked SDK, and the register the token.
            oauth2.token(tokenRequest, (err, accessToken) => {
                if (err)
                    return callback(err);
                accessToken.session_data = profile;
                // We now have to register the access token with the profile
                // Also delete the code from the redis, it's not needed anymore
                async.parallel({
                    deleteToken: (callback) => {
                        // We'll ignore what happens here.
                        profileStore.deleteTokenOrCode(tokenRequest.code);
                        return callback(null);
                    },
                    updateToken: (callback) => {
                        profileStore.registerTokenOrCode(accessToken, tokenRequest.api_id, profile, (err) => {
                            if (err)
                                return callback(err);
                            return callback(null, accessToken);
                        });
                    }
                }, (err, results) => {
                    if (err)
                        return callback(err);
                    return callback(null, accessToken);
                });
            });
        });
    }

    public getProfile(req, res, next) {
        debug(`/profile`);
        // OIDC profile end point, we need this. This is nice. Yeah.
        // res.status(500).json({ message: 'Not yet implemented.' });

        const bearerToken = req.get('authorization');
        if (!bearerToken)
            return failMessage(401, 'Unauthorized', next);
        let accessToken = null;
        if (bearerToken.indexOf(' ') > 0) {
            // assume Bearer xxx
            let tokenSplit = bearerToken.split(' ');
            if (tokenSplit.length !== 2)
                return failOAuth(400, 'invalid_request', 'Invalid Bearer token.', next);
            accessToken = bearerToken.split(' ')[1];
        } else {
            // Assume without "Bearer", just the access token
            accessToken = bearerToken;
        }
        accessToken = accessToken.trim();

        // Read from profile store.
        profileStore.retrieve(accessToken, (err, profile) => {
            if (err || !profile)
                return failOAuth(404, 'invalid_request', 'Not found', next);
            return res.status(200).json(profile);
        });
    }

    public wickedUserInfoToOidcProfile(userInfo: WickedUserInfo): OidcProfile {
        debug('wickedUserInfoToOidcProfile()');
        // Simple mapping to some basic OIDC profile claims
        const oidcProfile = {
            sub: userInfo.id,
            email: userInfo.email,
            email_verified: userInfo.validated
        };
        return oidcProfile;
    };

    public makeOidcProfile = (poolId: string, authResponse: AuthResponse, regInfo, callback) => {
        debug(`makeOidcProfile(${poolId}, ${authResponse.userId})`);
        const userId = authResponse.userId;
        const instance = this;

        // OK; we might be able to get the information from somewhere else, but let's keep
        // it simple.
        async.parallel({
            userInfo: callback => wicked.getUser(userId, callback),
            poolInfo: callback => utils.getPoolInfo(poolId, callback)
        }, function (err, results) {
            if (err)
                return callback(err);
            const userInfo = results.userInfo as WickedUserInfo;
            const poolInfo = results.poolInfo as WickedPool;

            const profile = instance.wickedUserInfoToOidcProfile(userInfo);
            // Now let's see what we can map from the registration
            for (let i = 0; i < poolInfo.properties.length; ++i) {
                const propInfo = poolInfo.properties[i];
                const propName = propInfo.id;
                if (!regInfo[propName])
                    continue;
                // If the property doesn't include a mapping to an OIDC claim, we can't use it
                if (!propInfo.oidcClaim)
                    continue;
                // Now assign the value to the OIDC claim in the profile
                profile[propInfo.oidcClaim] = regInfo[propName];
            }

            debug('makeOidcProfile() assembled the following profile:');
            debug(profile);

            return callback(null, profile);
        });
    }
};

export const utilsOAuth2 = new UtilsOAuth2();
