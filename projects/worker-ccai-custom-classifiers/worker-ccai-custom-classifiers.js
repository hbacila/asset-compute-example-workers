/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
'use strict';

const { worker, SourceCorruptError } = require('@adobe/asset-compute-sdk');
const { serializeXmp } = require("@adobe/asset-compute-xmp");
const axios = require('axios');

const path = require('path');
const { createReadStream } = require('fs');
const fs = require('fs').promises;
const FormData = require('form-data');
const multipart = require('parse-multipart');

const DEFAULT_CLASSIFIER_IDS = ['10021','10023'];
const DEFAULT_CCAI_ENDPOINT = "https://ccai-tagging-stage-va7.adobe.io/custom/images/v0/classifiers/CLASSIFIER_ID/predict_tags";

/**
 * @typedef {Object} Tag
 * @property {String} name Tag name
 * @property {Number} percentage Coverage percentage (0.0-1.0)
 */

/**
 * Parse the color feature response
 * 
 * @param {*} response JSON response from Content and Commerce AI service
 * @returns {Color[]} Color features returned by the service
 */
function parseTags(response) {
    const tags = [];
    if (response.result) {
        for (const tag in response.result[0].tags) {
            tags.push({
                'name': tag.tag,
                'percentage': tag.confidence
            });
        }
    }
    return tags;
}

exports.main = worker(async (source, rendition, params) => {
    // Acquire end point and analyzer
    const classifier_ids = rendition.instructions.CLASSIFIER_IDS || DEFAULT_CLASSIFIER_IDS;
    const endpoint = rendition.instructions.CCAI_ENDPOINT || DEFAULT_CCAI_ENDPOINT;
 
    // Make sure that the source file is not empty
    const stats = await fs.stat(source.path);
    if (stats.size === 0) {
        throw new SourceCorruptError('source file is empty');
    }

    // Authorization
    let accessToken = rendition.instructions.stageToken;
    let clientId = rendition.instructions.stageApiKey;
    let imsOrgId = rendition.instructions.stageImsOrgId;
    if (process.env.WORKER_TEST_MODE) {
        accessToken = "test-access-token";
        clientId = "test-client-id";
        imsOrgId = "test-ims-org-id"
    }

    // Execute request
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'cache-control': 'no-cache,no-cache',
        'Content-Type': 'application-json',
        'x-api-key': clientId,
        'x-gw-ims-org-id': imsOrgId,
        'x-gw-dsnpmms-sub-service': 'mmsrt'
    };
    const data = {
        "threshold": 0,
        "top_n": 3,
        "assets": [{
            "type": "url", 
            "asset": source.url
        }]
    };
   const tags = [];

    classifier_ids.forEach(async classifierId => {
        const classifierEndpoint = endpoint.replace('CLASSIFIER_ID', classifierId);
        try {
            const response = await axios.post(classifierEndpoint, data, { headers: headers });
            console.log("Response:", response);
            tags = tags.concat(parseTags(JSON.parse(response)));    
        } catch (e) {
            console.log("Exception:", e);
        }
   });
 
   // Serialize to XMP
    const xmp = serializeXmp({
        "ccai:labels": tags.map(tag => ({
            "ccai:name": tag.name,
            "ccai:percentage": tag.percentage
        }))
    }, {
        namespaces: {
            ccai: "https://example.com/schema/ccai"
        }
    });

    // Write XMP metadata as output
    await fs.writeFile(rendition.path, xmp);
});
