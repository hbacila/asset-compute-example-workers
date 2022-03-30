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
const fs = require('fs').promises;

const DEFAULT_CLASSIFIER_IDS = '10021,10023';
const DEFAULT_CCAI_ENDPOINT = "https://ccai-tagging-stage-va7.adobe.io/custom/images/v0/classifiers/CLASSIFIER_ID/predict_tags";

async function callClassifier(endpoint, classifierId, headers, data) {
    const classifierEndpoint = endpoint.replace('CLASSIFIER_ID', classifierId);
    const config = {
        method: 'post',
        url: classifierEndpoint,
        headers: headers,
        data: data
    };

    try {
        const response = await axios(config);
        return response.data.result[0].tags;    
    } catch(error) {
        if (error.response) {
            console.log(`Request failed: ${error.response.data.message || error.response.data}`);
            console.log(`x-request-id: ${error.response.headers['x-request-id']}`);
        }
        throw new Error(`Failed getting custom tags: ${error.response && error.response.status} ${error.response && error.response.statusText}`);
    }
}

exports.main = worker(async (source, rendition, params) => {
    // Acquire end point and analyzer
    const classifier_ids = (rendition.instructions.CLASSIFIER_IDS || DEFAULT_CLASSIFIER_IDS).split(',');
    const endpoint = rendition.instructions.CCAI_ENDPOINT || DEFAULT_CCAI_ENDPOINT;
 
    // Make sure that the source file is not empty
    const stats = await fs.stat(source.path);
    if (stats.size === 0) {
        throw new SourceCorruptError('source file is empty');
    }

    // Authorization
    let accessToken = rendition.instructions.STAGE_TOKEN;
    let clientId = rendition.instructions.STAGE_API_KEY;
    let imsOrgId = rendition.instructions.STAGE_IMS_ORG;
    if (process.env.WORKER_TEST_MODE) {
        accessToken = "test-access-token";
        clientId = "test-client-id";
        imsOrgId = "test-ims-org-id"
    }

    // Execute request
    const headers = {
        'x-gw-ims-org-id': imsOrgId,
        'x-api-key': clientId,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'cache-control': 'no-cache,no-cache'
    };
    const data = {
        "threshold": 0,
        "top_n": 3,
        "assets": [{
            "type": "url", 
            "asset": source.url
        }]
    };
   let allTags = [];

    for (const idx in classifier_ids) {
        const tags = await callClassifier(endpoint, classifier_ids[idx], headers, data);
        allTags = allTags.concat(tags);
    }
 
   // Serialize to XMP
    const xmp = serializeXmp({
        "ccai:labels": allTags.map(t => ({
            "ccai:name": t.tag,
            "ccai:percentage": t.confidence
        }))
    }, {
        namespaces: {
            ccai: "https://example.com/schema/ccai"
        }
    });

    // Write XMP metadata as output
    await fs.writeFile(rendition.path, xmp);
});
