import { push } from 'react-router-redux';
import {
  fetchEventTriggersQuery,
  fetchScheduledTriggersQuery,
  getBulkQuery,
  generateCreateScheduledTriggerQuery,
  getDropScheduledTriggerQuery,
  generateUpdateScheduledTriggerQuery,
  generateCreateEventTriggerQuery,
  getDropEventTriggerQuery,
  getCreateScheduledEventQuery,
  getRedeliverDataEventQuery,
  getSelectQuery,
  makeOrderBy,
} from '../../Common/utils/v1QueryUtils';
import { Thunk } from '../../../types';
import { makeMigrationCall } from '../Data/DataActions';
import requestAction from '../../../utils/requestAction';
import {
  getETModifyRoute,
  getScheduledEventsLandingRoute,
  getSTModifyRoute,
  getDataEventsLandingRoute,
  getAdhocPendingEventsRoute,
} from '../../Common/utils/routesUtils';
import { transformHeaders } from '../../Common/Headers/utils';
import { Table } from '../../Common/utils/pgUtils';
import { getConfirmation, isValidURL } from '../../Common/utils/jsUtils';
import { Nullable } from '../../Common/utils/tsUtils';
import Endpoints, { globalCookiePolicy } from '../../../Endpoints';
import dataHeaders from '../Data/Common/Headers';
import {
  TriggerKind,
  ScheduledTrigger,
  EventTrigger,
  EventKind,
  InvocationLog,
} from './types';
import { setScheduledTriggers, setEventTriggers, setTriggers } from './reducer';
import { LocalScheduledTriggerState } from './CronTriggers/state';
import { LocalAdhocEventState } from './AdhocEvents/Add/state';
import {
  LocalEventTriggerState,
  parseServerETDefinition,
} from './EventTriggers/state';
import { validateAddState as validateAdhocEventState } from './AdhocEvents/utils';
import { validateETState } from './EventTriggers/utils';
import {
  validateAddState,
  parseServerScheduledTrigger,
} from './CronTriggers/utils';
import {
  showErrorNotification,
  showSuccessNotification,
} from '../Common/Notification';
import { EventTriggerProperty } from './EventTriggers/Modify/utils';
import { getLogsTableDef } from './utils';

export const fetchTriggers = (
  kind: Nullable<TriggerKind>
): Thunk<Promise<void>> => (dispatch, getState) => {
  const bulkQueryArgs = [];
  if (kind) {
    bulkQueryArgs.push(
      kind === 'cron' ? fetchScheduledTriggersQuery : fetchEventTriggersQuery
    );
  } else {
    bulkQueryArgs.push(fetchEventTriggersQuery, fetchScheduledTriggersQuery);
  }

  return dispatch(
    requestAction(Endpoints.getSchema, {
      method: 'POST',
      credentials: globalCookiePolicy,
      headers: dataHeaders(getState),
      body: JSON.stringify(getBulkQuery(bulkQueryArgs)),
    })
  ).then(
    (data: (ScheduledTrigger[] | EventTrigger[])[]) => {
      if (kind) {
        if (kind === 'cron') {
          dispatch(setScheduledTriggers(data[0] as ScheduledTrigger[]));
        } else {
          dispatch(setEventTriggers(data[0] as EventTrigger[]));
        }
      } else {
        dispatch(
          setTriggers({
            event: data[0] as EventTrigger[],
            scheduled: data[1] as ScheduledTrigger[],
          })
        );
      }
      return Promise.resolve();
    },
    (error: any) => {
      console.error(`Failed to load event triggers${JSON.stringify(error)}`);
      return Promise.reject();
    }
  );
};

export const addScheduledTrigger = (
  state: LocalScheduledTriggerState,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => (dispatch, getState) => {
  const validationError = validateAddState(state);

  const errorMsg = 'Creating scheduled trigger failed';
  if (validationError) {
    if (errorCb) {
      errorCb();
    }
    return dispatch(showErrorNotification(errorMsg, validationError));
  }

  const upQuery = generateCreateScheduledTriggerQuery(state);
  const downQuery = getDropScheduledTriggerQuery(state.name);

  const migrationName = `create_scheduled_trigger_${state.name}`;
  const requestMsg = 'Creating scheduled trigger...';
  const successMsg = 'Created scheduled trigger successfully';

  const customOnSuccess = () => {
    dispatch(fetchTriggers('cron'))
      .then(() => {
        if (successCb) {
          successCb();
        }
        dispatch(push(getSTModifyRoute(state.name, 'absolute')));
      })
      .catch(() => {
        if (errorCb) {
          errorCb();
        }
      });
  };
  const customOnError = () => {
    if (errorCb) {
      errorCb();
    }
  };

  return makeMigrationCall(
    dispatch,
    getState,
    [upQuery],
    [downQuery],
    migrationName,
    customOnSuccess,
    customOnError,
    requestMsg,
    successMsg,
    errorMsg,
    false
  );
};

export const saveScheduledTrigger = (
  state: LocalScheduledTriggerState,
  existingTrigger: ScheduledTrigger,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => (dispatch, getState) => {
  const validationError = validateAddState(state);

  const errorMsg = 'Updating scheduled trigger failed';
  if (validationError) {
    if (errorCb) {
      errorCb();
    }
    return dispatch(showErrorNotification(errorMsg, validationError));
  }

  const isRenamed = state.name !== existingTrigger.name;
  if (isRenamed) {
    const isOk = getConfirmation(
      'Renaming a trigger deletes the current trigger and creates a new trigger with this configuration. All the events of the current trigger will be dropped.',
      true,
      'RENAME'
    );
    if (!isOk) {
      if (errorCb) {
        errorCb();
      }
      return null;
    }
  }

  const replaceQueryUp = generateUpdateScheduledTriggerQuery(state);
  const replaceQueryDown = generateUpdateScheduledTriggerQuery(
    parseServerScheduledTrigger(existingTrigger)
  );

  const upRenameQueries = [
    getDropScheduledTriggerQuery(existingTrigger.name),
    generateCreateScheduledTriggerQuery(state),
  ];
  const downRenameQueries = [
    getDropScheduledTriggerQuery(state.name),
    generateCreateScheduledTriggerQuery(
      parseServerScheduledTrigger(existingTrigger)
    ),
  ];

  const migrationName = `update_scheduled_trigger_${existingTrigger.name}_to_${state.name}`;
  const requestMsg = 'Updating scheduled trigger...';
  const successMsg = 'Updated scheduled trigger successfully';

  const customOnSuccess = () => {
    if (isRenamed) {
      const newHref = window.location.href.replace(
        getSTModifyRoute(existingTrigger.name, 'relative'),
        getSTModifyRoute(state.name, 'relative')
      );
      return window.location.replace(newHref);
    }
    return dispatch(fetchTriggers('cron'))
      .then(() => {
        if (successCb) {
          successCb();
        }
      })
      .catch(() => {
        if (errorCb) {
          errorCb();
        }
      });
  };
  const customOnError = () => {
    if (errorCb) {
      errorCb();
    }
  };

  return makeMigrationCall(
    dispatch,
    getState,
    isRenamed ? upRenameQueries : [replaceQueryUp],
    isRenamed ? downRenameQueries : [replaceQueryDown],
    migrationName,
    customOnSuccess,
    customOnError,
    requestMsg,
    successMsg,
    errorMsg,
    false
  );
};

export const deleteScheduledTrigger = (
  trigger: ScheduledTrigger,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => (dispatch, getState) => {
  const isOk = getConfirmation(
    `This will delete the cron trigger permanently and delete all the associated events.`,
    true,
    trigger.name
  );
  if (!isOk) {
    if (errorCb) {
      errorCb();
    }
    return;
  }

  const upQuery = getDropScheduledTriggerQuery(trigger.name);
  const downQuery = generateCreateScheduledTriggerQuery(
    parseServerScheduledTrigger(trigger)
  );

  const migrationName = `delete_scheduled_trigger_${trigger.name}`;
  const requestMsg = 'Deleting scheduled trigger...';
  const errorMsg = 'Deleting scheduled trigger failed';
  const successMsg = 'Deleted scheduled trigger successfully';

  const customOnSuccess = () => {
    if (successCb) {
      successCb();
    }
    dispatch(push(getScheduledEventsLandingRoute('absolute')));
    dispatch(fetchTriggers('cron'));
  };
  const customOnError = () => {
    if (errorCb) {
      errorCb();
    }
  };

  makeMigrationCall(
    dispatch,
    getState,
    [upQuery],
    [downQuery],
    migrationName,
    customOnSuccess,
    customOnError,
    requestMsg,
    successMsg,
    errorMsg,
    false
  );
};

export const createEventTrigger = (
  state: LocalEventTriggerState,
  successCb?: () => null,
  errorCb?: () => null
): Thunk => {
  return (dispatch, getState) => {
    const validationError = validateETState(state);
    if (validationError) {
      dispatch(
        showErrorNotification('Creating event trigger failed', validationError)
      );
    }

    const migrationName = `create_event_trigger_${state.name.trim()}`;

    const upQuery = generateCreateEventTriggerQuery(state);
    const downQuery = getDropEventTriggerQuery(state.name);

    const requestMsg = 'Creating event trigger...';
    const successMsg = 'Event Trigger Created';
    const errorMsg = 'Creating event trigger failed';

    const customOnSuccess = () => {
      if (successCb) {
        successCb();
      }
      dispatch(fetchTriggers('event')).then(() => {
        dispatch(push(getETModifyRoute(state.name)));
      });
    };
    const customOnError = () => {
      if (errorCb) {
        errorCb();
      }
    };

    makeMigrationCall(
      dispatch,
      getState,
      [upQuery],
      [downQuery],
      migrationName,
      customOnSuccess,
      customOnError,
      requestMsg,
      successMsg,
      errorMsg,
      true
    );
  };
};

export const modifyEventTrigger = (
  property: EventTriggerProperty,
  state: LocalEventTriggerState,
  trigger: EventTrigger,
  table?: Table,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => (dispatch, getState) => {
  const downQuery = generateCreateEventTriggerQuery(
    parseServerETDefinition(trigger, table),
    true
  );

  // TODO optimise redeclaration of queries

  const upQuery = generateCreateEventTriggerQuery(
    parseServerETDefinition(trigger, table),
    true
  );

  const errorMsg = 'Saving failed';

  switch (property) {
    case 'webhook': {
      if (state.webhook.type === 'static' && !isValidURL(state.webhook.value)) {
        return dispatch(showErrorNotification(errorMsg, 'Invalid URL'));
      }
      upQuery.args = {
        ...upQuery.args,
        webhook: state.webhook.type === 'static' ? state.webhook.value : null,
        webhook_from_env:
          state.webhook.type === 'env' ? state.webhook.value : null,
      };
      break;
    }
    case 'ops': {
      upQuery.args = {
        ...upQuery.args,
        insert: state.operations.insert ? { columns: '*' } : null,
        update: state.operations.update
          ? {
              columns: state.operationColumns
                .filter(c => !!c.enabled)
                .map(c => c.name),
              payload: state.operationColumns
                .filter(c => !!c.enabled)
                .map(c => c.name),
            }
          : null,
        delete: state.operations.delete ? { columns: '*' } : null,
        enable_manual: state.operations.enable_manual,
      };
      break;
    }
    case 'retry_conf': {
      upQuery.args.retry_conf = state.retryConf;
      break;
    }
    case 'headers': {
      upQuery.args.headers = transformHeaders(state.headers);
      break;
    }
    default:
      break;
  }

  const migrationName = `set_et_${state.name.trim()}_${property}`;

  const requestMsg = 'Saving...';
  const successMsg = 'Saved';

  const customOnSuccess = () => {
    if (successCb) {
      successCb();
    }
    dispatch(fetchTriggers('event'));
  };

  const customOnError = () => {
    if (errorCb) {
      errorCb();
    }
  };

  return makeMigrationCall(
    dispatch,
    getState,
    [upQuery],
    [downQuery],
    migrationName,
    customOnSuccess,
    customOnError,
    requestMsg,
    successMsg,
    errorMsg,
    true
  );
};

export const deleteEventTrigger = (
  trigger: EventTrigger,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => (dispatch, getState) => {
  const isOk = getConfirmation(
    `This will permanently delete the event trigger and the associated metadata`,
    true,
    trigger.name
  );
  if (!isOk) {
    return undefined;
  }

  const upQuery = getDropEventTriggerQuery(trigger.name);
  const downQuery = generateCreateEventTriggerQuery(
    parseServerETDefinition(trigger)
  );

  const migrationName = `delete_et_${trigger.name}`;

  const requestMsg = 'Deleting event trigger...';
  const successMsg = 'Deleted event trigger';
  const errorMsg = 'Deleting event trigger failed';

  const customOnSuccess = () => {
    if (successCb) {
      successCb();
    }
    dispatch(push(getDataEventsLandingRoute()));
    dispatch(fetchTriggers('event'));
  };

  const customOnError = () => {
    if (errorCb) {
      errorCb();
    }
  };

  return makeMigrationCall(
    dispatch,
    getState,
    [upQuery],
    [downQuery],
    migrationName,
    customOnSuccess,
    customOnError,
    requestMsg,
    successMsg,
    errorMsg,
    true
  );
};

export const createScheduledEvent = (
  state: LocalAdhocEventState,
  successCb?: () => void,
  errorCb?: () => void
): Thunk => dispatch => {
  const validationError = validateAdhocEventState(state);
  const errorMessage = 'Failed scheduling the event';
  if (validationError) {
    if (errorCb) {
      errorCb();
    }
    return dispatch(showErrorNotification(errorMessage, validationError));
  }

  const query = getCreateScheduledEventQuery(state);
  return dispatch(
    requestAction(
      Endpoints.query,
      {
        method: 'POST',
        body: JSON.stringify(query),
      },
      undefined,
      undefined,
      true,
      true
    )
  ).then(
    () => {
      if (successCb) {
        successCb();
      }
      dispatch(showSuccessNotification('Event scheduled successfully'));
      dispatch(push(getAdhocPendingEventsRoute('absolute')));
    },
    (error: any) => {
      dispatch(showErrorNotification(errorMessage, error.message || '', error));
      if (errorCb) {
        errorCb();
      }
    }
  );
};

export const redeliverDataEvent = (
  eventId: string,
  successCb?: CallableFunction,
  errorCb?: CallableFunction
): Thunk => (dispatch, getState) => {
  const url = Endpoints.getSchema;
  const options = {
    method: 'POST',
    headers: dataHeaders(getState),
    body: JSON.stringify(getRedeliverDataEventQuery(eventId)),
  };
  return dispatch(
    requestAction(url, options, undefined, undefined, true, true)
  ).then(
    () => {
      if (successCb) {
        successCb();
      }
    },
    (error: any) => {
      if (errorCb) {
        errorCb();
      }
      dispatch(
        showErrorNotification(
          'Failed to redeliver event',
          error.message || 'unexpected',
          error
        )
      );
    }
  );
};

export const getEventLogs = (
  eventId: string,
  eventKind: EventKind,
  successCallback: (logs: InvocationLog[]) => void,
  errorCallback: (error: any) => void
): Thunk => dispatch => {
  const logTableDef = getLogsTableDef(eventKind);

  const query = getSelectQuery(
    'select',
    logTableDef,
    ['*'],
    {
      event_id: {
        $eq: eventId,
      },
    },
    0,
    null,
    [makeOrderBy('created_at', 'desc')]
  );

  dispatch(
    requestAction(
      Endpoints.query,
      {
        method: 'POST',
        body: JSON.stringify(query),
      },
      undefined,
      undefined,
      true,
      true
    )
  ).then((data: InvocationLog[]) => {
    successCallback(data);
  }, errorCallback);
};
