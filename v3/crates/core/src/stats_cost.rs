//! Estimates from user-supplied rates and disjoint, normalized token dimensions.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type TokenPricingDocument = BTreeMap<String, TokenPricingEntry>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPricingEntry {
    pub currency: String,
    pub input_per_million: f64,
    pub output_per_million: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_of: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct CostTokenTotals {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub total_cost: Option<f64>,
    pub currency: String,
    pub source_label: String,
    pub source_url: String,
    pub as_of: String,
    pub breakdown: BTreeMap<&'static str, CostDimension>,
    pub omitted_dimensions: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct CostDimension {
    pub tokens: u64,
    pub cost: f64,
}

pub(crate) fn compute_cost_estimate(
    pricing: &TokenPricingEntry,
    tokens: &CostTokenTotals,
) -> crate::Result<CostEstimate> {
    let mut estimate = CostEstimate {
        total_cost: None,
        currency: pricing.currency.trim().to_ascii_uppercase(),
        source_label: pricing.source_label.clone().unwrap_or_default(),
        source_url: pricing.source_url.clone().unwrap_or_default(),
        as_of: pricing.as_of.clone().unwrap_or_default(),
        breakdown: BTreeMap::new(),
        omitted_dimensions: vec![],
    };
    for (dimension, omitted, tokens, rate) in [
        (
            "input",
            "input",
            tokens.input,
            Some(pricing.input_per_million),
        ),
        (
            "output",
            "output",
            tokens.output,
            Some(pricing.output_per_million),
        ),
        (
            "reasoning",
            "reasoning",
            tokens.reasoning,
            pricing.reasoning_per_million,
        ),
        (
            "cacheRead",
            "cache-read",
            tokens.cache_read,
            pricing.cache_read_per_million,
        ),
        (
            "cacheWrite",
            "cache-write",
            tokens.cache_write,
            pricing.cache_write_per_million,
        ),
    ] {
        match (tokens, rate) {
            (Some(0), _) => {
                estimate.total_cost.get_or_insert(0.0);
            }
            (Some(tokens), Some(rate)) => {
                let cost = tokens as f64 * (rate / 1_000_000.0);
                *estimate.total_cost.get_or_insert(0.0) += cost;
                if !estimate
                    .total_cost
                    .expect("priced dimension total")
                    .is_finite()
                {
                    return Err(crate::CoreError::InvalidInput(
                        "cost estimate exceeds the finite numeric range".into(),
                    ));
                }
                estimate
                    .breakdown
                    .insert(dimension, CostDimension { tokens, cost });
            }
            _ => estimate.omitted_dimensions.push(omitted),
        }
    }
    Ok(estimate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_dimension_is_omitted_and_explicit_zero_rate_is_retained() {
        let pricing: TokenPricingEntry = serde_json::from_value(serde_json::json!({
            "currency": "usd", "inputPerMillion": 2, "outputPerMillion": 4,
            "cacheReadPerMillion": 0
        }))
        .unwrap();
        let tokens = CostTokenTotals {
            input: Some(1_000_000),
            output: None,
            reasoning: Some(0),
            cache_read: Some(10),
            cache_write: Some(5),
        };
        let result = compute_cost_estimate(&pricing, &tokens).unwrap();
        assert_eq!(result.total_cost, Some(2.0));
        assert_eq!(result.breakdown["cacheRead"].tokens, 10);
        assert_eq!(result.breakdown["cacheRead"].cost, 0.0);
        assert_eq!(result.omitted_dimensions, ["output", "cache-write"]);
        let empty = compute_cost_estimate(&pricing, &CostTokenTotals::default()).unwrap();
        assert_eq!(empty.total_cost, None);
        assert!(empty.breakdown.is_empty());
        assert_eq!(
            empty.omitted_dimensions,
            ["input", "output", "reasoning", "cache-read", "cache-write"]
        );
        let enormous = TokenPricingEntry {
            input_per_million: f64::MAX,
            ..pricing
        };
        let tokens = CostTokenTotals {
            input: Some(u64::MAX),
            ..CostTokenTotals::default()
        };
        assert!(compute_cost_estimate(&enormous, &tokens).is_err());
    }
}
