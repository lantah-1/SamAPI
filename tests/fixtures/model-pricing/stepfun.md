> ## Documentation Index
> Fetch the complete documentation index at: https://platform.stepfun.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Pricing and Rate Limits

## Pricing Details

### Pricing for Multimodal Reasoning Models

| Model          | Billing Unit | Input (Cache Miss) | Input (Cache Hit) | Output Price |
| :------------- | :----------- | :----------------- | :---------------- | :----------- |
| step-3.7-flash | 1M tokens    | \$0.20             | \$0.04            | \$1.15       |

### Pricing for Reasoning Models

| Model               | Billing Unit | Input (Cache Miss) | Input (Cache Hit) | Output Price |
| :------------------ | :----------- | :----------------- | :---------------- | :----------- |
| step-3.5-flash-2603 | 1M tokens    | \$0.10             | \$0.02            | \$0.30       |
| step-3.5-flash      | 1M tokens    | \$0.10             | \$0.02            | \$0.30       |

### Pricing for End-to-End Speech Models

| Model                  | Billing Unit | Input (Cache Miss) | Input (Cache Hit) | Output Price |
| :--------------------- | :----------- | :----------------- | :---------------- | :----------- |
| stepaudio-2.5-chat     | 1M tokens    | \$1.50             | \$0.30            | \$3.50       |
| stepaudio-2.5-realtime | 1M tokens    | \$1.50             | \$0.30            | \$10.00      |

### Pricing for Speech Models

| Model                    | Model Type                         | Unit Price                 |
| :----------------------- | :--------------------------------- | :------------------------- |
| stepaudio-2.5-tts        | Contextual text-to-speech model    | \$0.85 / 10,000 characters |
| stepaudio-2.5-tts        | Voice cloning model                | \$1.50 / voice             |
| stepaudio-2.5-asr        | Speech recognition model           | \$0.022 / hour             |
| stepaudio-2.5-asr-stream | Streaming speech recognition model | \$0.18 / hour              |

Here, one Chinese character counts as one character, two English letters count as one character, and two punctuation marks count as one character.

## Tiered Rate Limits

### Top-Up and Rate Limits Table

To ensure fair overall resource allocation and prevent abuse, we apply rate limits based on your account's cumulative top-up amount. Details are below:

| User Tier | Cumulative Top-Up Amount | Concurrency | RPM     | TPM         |
| :-------: | :----------------------- | :---------- | :------ | :---------- |
|     V0    | \$0                      | 5           | 10      | 5,000,000   |
|     V1    | \$15                     | 100         | 1,000   | 20,000,000  |
|     V2    | \$70                     | 200         | 5,000   | 30,000,000  |
|     V3    | \$300                    | 400         | 10,000  | 40,000,000  |
|     V4    | \$700                    | 1,000       | 20,000  | 50,000,000  |
|     V5    | \$1,500                  | 10,000      | 200,000 | 100,000,000 |

### Definitions

* Concurrency: number of requests at the same time
* RPM: request per minute, the maximum number of requests you can make to us per minute
* TPM: token per minute, the maximum number of tokens you can interact with us per minute

### Notes

* Our default rate limits are intended to allocate resources more fairly. If you believe you need higher and more stable limits, please contact our staff in advance; we will respond within two business days. Contact email: [platform@stepfun.com](mailto:platform@stepfun.com)
* We will do our best to ensure normal usage, but when resources reach capacity, we may take temporary throttling measures and adjust rate limits.
