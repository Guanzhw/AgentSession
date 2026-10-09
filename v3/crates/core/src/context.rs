use crate::{Core, CoreError, EventRef, Result, TimelineEvent};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    pub target: EventRef,
    pub events: Vec<TimelineEvent>,
    pub untrusted_content: bool,
}

impl Core {
    pub fn session_context(
        &self,
        target: &EventRef,
        before: usize,
        after: usize,
        include_thinking: bool,
    ) -> Result<SessionContext> {
        if before > 20 || after > 20 {
            return Err(CoreError::InvalidInput(
                "before and after must each be between 0 and 20".into(),
            ));
        }
        if target.segment == "thinking" && !include_thinking {
            return Err(CoreError::InvalidInput(
                "thinking event requires explicit opt-in".into(),
            ));
        }
        let events: Vec<_> = self
            .timeline(&target.provider, &target.session_id)?
            .into_iter()
            .filter(|row| include_thinking || row.event.segment != "thinking")
            .collect();
        let position = events
            .iter()
            .position(|row| row.event == *target)
            .ok_or_else(|| CoreError::EventNotFound(target.message_id.clone()))?;
        Ok(SessionContext {
            target: target.clone(),
            events: events
                [position.saturating_sub(before)..(position + after + 1).min(events.len())]
                .to_vec(),
            untrusted_content: true,
        })
    }
}
