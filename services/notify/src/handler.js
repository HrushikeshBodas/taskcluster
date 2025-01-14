const _ = require('lodash');
const jsone = require('json-e');
const {consume} = require('taskcluster-lib-pulse');
const libUrls = require('taskcluster-lib-urls');

/** Handler listening for tasks that carries notifications */
class Handler {
  constructor(options) {
    const {
      rootUrl,
      notifier,
      monitor,
      routePrefix,
      ignoreTaskReasonResolved,
      pulseClient,
      queue,
      queueEvents,
    } = options;

    this.rootUrl = rootUrl;
    this.queue = queue;
    this.notifier = notifier;
    this.monitor = monitor;
    this.routePrefix = routePrefix;
    this.ignoreTaskReasonResolved = ignoreTaskReasonResolved;

    this.pulseClient = pulseClient;
    this.bindings = [
      queueEvents.taskCompleted(`route.${routePrefix}.#.on-completed.#`),
      queueEvents.taskCompleted(`route.${routePrefix}.#.on-any.#`),
      queueEvents.taskFailed(`route.${routePrefix}.#.on-failed.#`),
      queueEvents.taskFailed(`route.${routePrefix}.#.on-any.#`),
      queueEvents.taskException(`route.${routePrefix}.#.on-exception.#`),
      queueEvents.taskException(`route.${routePrefix}.#.on-any.#`),
    ];
  }

  async listen() {
    this.pq = await consume({
      client: this.pulseClient,
      bindings: this.bindings,
      queueName: 'notifications',
    },
    this.monitor.timedHandler('notification', this.onMessage.bind(this))
    );
  }

  renderMessage(template, context) {
    try {
      return jsone(template, context);
    } catch (err) {
      // We will try to deliver nice error messages for json-e errors
      if (err.name && _.includes(['BuiltinError', 'TemplateError', 'InterpreterError', 'SyntaxError'], err.name)) {
        return `Error parsing custom message: ${err.message}`;
      }
      throw err;
    }
  }

  async onMessage(message) {
    let {status} = message.payload;

    // If task was canceled, we don't send a notification since this was a deliberate user action
    if (status.state === 'exception') {
      if (this.ignoreTaskReasonResolved.includes((_.last(status.runs) || {}).reasonResolved)) {
        return null;
      }
    }

    // Load task definition
    let taskId = status.taskId;
    let task = await this.queue.task(taskId);
    let href = libUrls.ui(this.rootUrl, `tasks/${taskId}`);
    let groupHref = libUrls.ui(this.rootUrl, `groups/${taskId}/tasks`);
    let runCount = status.runs.length;

    return Promise.all(message.routes.map(entry => {
      let route = entry.split('.');

      // convert from on- syntax to state. e.g. on-exception -> exception
      let decider = _.join(_.slice(route[route.length -1], 3), '');
      if (decider !== 'any' && status.state !== decider) {
        return null;
      }

      let ircMessage = `Task "${task.metadata.name}" complete with status '${status.state}'. Inspect: ${href}`;

      switch (route[1]) {
        case 'irc-user': {
          if (_.has(task, 'extra.notify.ircUserMessage')) {
            ircMessage = this.renderMessage(task.extra.notify.ircUserMessage, {task, status});
          }
          return this.notifier.irc({
            user: route[2],
            message: ircMessage,
          });
        }
        case 'irc-channel': {
          if (_.has(task, 'extra.notify.ircChannelMessage')) {
            ircMessage = this.renderMessage(task.extra.notify.ircChannelMessage, {task, status});
          }
          return this.notifier.irc({
            channel: route[2],
            message: ircMessage,
          });
        }
        case 'slack-user': {
          if (_.has(task, 'extra.notify.slackUserMessage')) {
            slackMessage = this.renderMessage(task.extra.notify.slackUserMessage, {task, status});
          }
          return this.notifier.slack({
            user: route[2],
            message: slackMessage,
          });
        }
        case 'slack-channel': {
          if (_.has(task, 'extra.notify.slackChannelMessage')) {
            slackMessage = this.renderMessage(task.extra.notify.slackChannelMessage, {task, status});
          }
          return this.notifier.slack({
            channel: route[2],
            message: slackMessage,
          });
        }
        case 'pulse': {
          return this.notifier.pulse({
            routingKey: _.join(_.slice(route, 2, route.length - 1), '.'),
            message: status,
          });
        }
        case 'email': {
          let content = `
Task [\`${taskId}\`](${href}) in task-group [\`${task.taskGroupId}\`](${groupHref}) is complete.

**Status:** ${status.state} (in ${runCount} run${runCount === 1? '' : 's'})
**Name:** ${task.metadata.name}
**Description:** ${task.metadata.description}
**Owner:** ${task.metadata.owner}
**Source:** ${task.metadata.source}
          `;
          let link = {text: 'Inspect Task', href};
          let subject = `Task ${status.state}: ${task.metadata.name} - ${taskId}`;
          let template = 'simple';
          if (_.has(task, 'extra.notify.email')) {
            let extra = task.extra.notify.email;
            content = extra.content ? this.renderMessage(extra.content, {task, status}) : content;
            subject = extra.subject ? this.renderMessage(extra.subject, {task, status}) : subject;
            link = extra.link ? jsone(extra.link, {task, status}) : link;
            template = extra.template ? jsone(extra.template, {task, status}) : template;
          }
          return this.notifier.email({
            address: _.join(_.slice(route, 2, route.length - 1), '.'),
            content,
            subject,
            link,
            template,
          });
        }
        default: {
          return null;
        }}
    }));
  }
}

// Export Handler
module.exports = Handler;
