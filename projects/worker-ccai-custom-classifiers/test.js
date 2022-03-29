 
const axios = require('axios');
const https = require('https');
require('dotenv').config();

const headers = { 
    'Authorization': `Bearer ${process.env.STAGE_TOKEN}`,
    'Content-Type': 'application/json',
    'x-api-key': process.env.STAGE_API_KEY, 
    'x-gw-ims-org-id': process.env.STAGE_ORG_ID,
    'cache-control': 'no-cache,no-cache'
};
const data = {
    "threshold": 0,
    "top_n": 3,
    "assets": [{
        "type": "url", 
        "asset": "https://image.made-in-china.com/202f0j00kQofOSnGCqbY/Abstract-Human-Figure-Oil-Art-Painting-for-Living-Room.jpg"
    }]
};


async function axiosRequest() {
    console.log("Execute request using axios");

    const endpoint = "https://ccai-tagging-stage-va7.adobe.io/custom/images/v0/classifiers/10021/predict_tags";
    const request = {
        method: 'post',
        url: endpoint,
        headers: headers,
        data : data
    };

    await axios(request)
        .then(function (response) {
            console.log(JSON.stringify(response.data));
        })
        .catch(function (error) {
            if (error.response) {
                console.log(`Request failed: ${error.response.data.message}`);
                console.log(`x-request-id: ${error.response.headers['x-request-id']}`);
            }
        });
}

async function httpsRequest() {
    console.log("Execute request using https");

    let request = new Promise((resolve, reject) => {
        const post_data = JSON.stringify(data);
        const post_options = {
            host: 'ccai-tagging-stage-va7.adobe.io',
            port: '443',
            path: '/custom/images/v0/classifiers/10021/predict_tags',
            method: 'POST',
            headers: headers
        };

        const req = https.request(post_options, function(res) {
            let response_body = "";
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                response_body = response_body.concat(chunk);
            });
            res.on('end', () => {
                resolve(response_body);
            });
            res.on('error', (error) => {
                reject(error);
            });
        });

        req.write(post_data, 'utf-8');
        req.end();
    });

    request.then((response) => {
        console.log(response);
    }).catch((error) => {
        console.log(error);
    });

    await request;
}

(async function () {
    await axiosRequest();
	await httpsRequest();
})();
