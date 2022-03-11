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

const DEFAULT_ANALYZER_ID = "Feature:cintel-image-classifier:Service-60887e328ded447d86e01122a4f19c58";
const DEFAULT_CCAI_ENDPOINT = "https://sensei-stage-va6.adobe.io/services/v2/predict";

/**
 * @typedef {Object} Color
 * @property {String} name Color name
 * @property {Number} percentage Coverage percentage (0.0-1.0)
 * @property {Number} red Red channel (0-255)
 * @property {Number} green Green channel (0-255)
 * @property {Number} blue Blue channel (0-255) 
 */

/**
 * Parse the color feature response
 * 
 * @param {*} response JSON response from Content and Commerce AI service
 * @returns {Color[]} Color features returned by the service
 */
function parseColors(response) {
    const colors = [];
    if (response.status == 200) {
        const body = response.data;
        const boundary = multipart.getBoundary(response.headers['content-type']);
        const parts = body.split("--"+boundary); 

        for(const i in parts) {
            const part = parts[i];
            if (part.indexOf('Content-Disposition: form-data; name="result"') > 0) {
                const subParts = part.split('\r\n');
                const responseJson = JSON.parse(subParts[4]);
                for (const name in responseJson[0].colors) {
                    const color = responseJson[0].colors[name];
                    colors.push({
                        name,
                        'percentage': color.coverage,
                        'red': color.rgb.red,
                        'green': color.rgb.green,
                        'blue': color.rgb.blue
                    });
                }
                break;
            }
        }    
    }

    return colors;
}

/**
 * Sort colors, high coverage to low coverage
 * 
 * @param {Color[]} colors Color features
 * @return {Color[]} Color features sorted by percentage (high to low)
 */
function sortColors(colors) {
    colors.sort((a, b) => b.percentage - a.percentage);
}

/**
 * Convert a percentage to a string
 * 
 * @param {Color} color Color feature
 * @returns Percentage as a string, e.g. 59%
 */
function toPercentageString(color) {
    return `${Math.round(color.percentage * 100.0)}%`;
}

/**
 * Convert a color feature to a web color
 * 
 * @param {Color} color Color feature
 * @returns Web color, e.g. `#a909fe`
 */
function toWebColor(color) {
    const arr = [color.red, color.green, color.blue];
    return `#${Buffer.from(arr).toString('hex')}`;
}

exports.main = worker(async (source, rendition, params) => {
    // Acquire end point and analyzer
    const analyzer_id = rendition.instructions.ANALYZER_ID || DEFAULT_ANALYZER_ID;
    const endpoint = rendition.instructions.CCAI_ENDPOINT || DEFAULT_CCAI_ENDPOINT;
    console.log("Using analyzer:", analyzer_id);
    console.log("Using endpoint:", endpoint);
    // console.log("Source:", source);
    console.log("Stage apiKey:", rendition.instructions.stageApiKey);
    console.log("Stage token:", rendition.instructions.stageToken);
    // console.log("Params:", params);

    // Make sure that the source file is not empty
    const stats = await fs.stat(source.path);
    if (stats.size === 0) {
        throw new SourceCorruptError('source file is empty');
    }

    // Build parameters to send to Sensei service
    const format = "image/" + path.extname(source.path);
    const parameters = {
        "sensei:name": analyzer_id,
        "sensei:invocation_mode": "synchronous",
        "sensei:invocation_batch": false,
        "sensei:engines": [
          {
            "sensei:execution_info": {
              "sensei:engine": analyzer_id
            },
            "sensei:inputs": {
              "documents": [{
                  "sensei:multipart_field_name": "infile",
                  "dc:format": "image/jpg"
                }]
            },
            "sensei:params": {
              "application-id": "1234",
              "enable_mask": 0
            },
            "sensei:outputs":{
              "result" : {
                "sensei:multipart_field_name" : "result",
                "dc:format": "application/json"
              }
            }
          }
        ]
    };

    console.log("STRING: ", JSON.stringify(parameters));

    if (rendition.instructions.SENSEI_PARAMS) {
        parameters = JSON.parse(rendition.instructions.SENSEI_PARAMS);
        parameters.encoding = ext;
        parameters.data[0].encoding = ext;
    }

    // Build form to post
    const formData = new FormData();
    formData.append('infile', createReadStream(source.path));
    formData.append('contentAnalyzerRequests', JSON.stringify(parameters));
 
    // Authorization
    let accessToken = rendition.instructions.stageToken;
    let clientId = rendition.instructions.stageApiKey;
    if (process.env.WORKER_TEST_MODE) {
        accessToken = "test-access-token";
        clientId = "test-client-id";
    }

    // Execute request
    const request = {
        method: 'post',
        url: endpoint,
        data: formData,
        maxBodyLength: Infinity,
        headers: Object.assign({
            'Authorization': `Bearer ${accessToken}`,
            'cache-control': 'no-cache,no-cache',
            'Content-Type': 'multipart/form-data',
            'x-api-key': clientId,
            'Prefer': 'respond-async, wait=59'
        }, formData.getHeaders())
    };
    const response = await axios(request);

    // Parse, sort, serialize to XMP
    const colors = parseColors(response);
    sortColors(colors);
    const xmp = serializeXmp({
        "ccai:colorNames": colors.map(color => `${color.name}, ${toPercentageString(color)}`),
        "ccai:colorRGB": colors.map(color => `${toWebColor(color)}, ${toPercentageString(color)}`),
        "ccai:colors": colors.map(color => ({
            "ccai:name": color.name,
            "ccai:percentage": color.percentage,
            "ccai:red": color.red,
            "ccai:green": color.green,
            "ccai:blue": color.blue
        }))
    }, {
        namespaces: {
            ccai: "https://example.com/schema/ccai"
        }
    });

    // Write XMP metadata as output
    await fs.writeFile(rendition.path, xmp);
});
