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
        let session = self.load_session(&target.provider, &target.session_id)?;
        let position = session
            .events
            .iter()
            .position(|entry| entry.item.event == *target)
            .ok_or_else(|| CoreError::EventNotFound(target.message_id.clone()))?;
        let visible = |entry: &&crate::providers::NormalizedEvent| {
            include_thinking || entry.item.event.segment != "thinking"
        };
        let mut preceding: Vec<_> = session.events[..position]
            .iter()
            .rev()
            .filter(visible)
            .take(before)
            .collect();
        preceding.reverse();
        let events = preceding
            .into_iter()
            .chain(std::iter::once(&session.events[position]))
            .chain(
                session.events[position + 1..]
                    .iter()
                    .filter(visible)
                    .take(after),
            )
            .map(|entry| crate::project_timeline_event(entry, None))
            .collect();
        Ok(SessionContext {
            target: target.clone(),
            events,
            untrusted_content: true,
        })
    }
}
