// @flow
const debug = require('debug')('iris:mutations:message');
import detectLang from 'lang-detector';
import UserError from '../utils/UserError';
import {
  storeMessage,
  getMessage,
  deleteMessage,
  userHasMessagesInThread,
} from '../models/message';
import { setDirectMessageThreadLastActive } from '../models/directMessageThread';
import {
  createParticipantInThread,
  deleteParticipantInThread,
  createParticipantWithoutNotificationsInThread,
} from '../models/usersThreads';
import { setUserLastSeenInDirectMessageThread } from '../models/usersDirectMessageThreads';
import { getThread } from '../models/thread';
import { getUserPermissionsInCommunity } from '../models/usersCommunities';
import { getUserPermissionsInChannel } from '../models/usersChannels';
import { uploadImage } from '../utils/s3';
import { toState, toPlainText } from 'shared/draft-utils';
import type { Message } from '../models/message';
import type { GraphQLContext } from '../';

type AddMessageProps = {
  message: Message,
};

type DeleteMessageInput = {
  id: string,
};

module.exports = {
  Mutation: {
    addMessage: async (
      _: any,
      { message }: AddMessageProps,
      { user, loaders }: GraphQLContext
    ) => {
      const currentUser = user;
      // user must be authed to send a message
      if (!currentUser) {
        return new UserError('You must be signed in to send a message.');
      }

      const thread = await getThread(message.threadId);

      // if the message was a dm thread, set the last seen and last active times
      if (message.threadType === 'directMessageThread') {
        setDirectMessageThreadLastActive(message.threadId);
        setUserLastSeenInDirectMessageThread(message.threadId, currentUser.id);
      }

      // if the message was sent in a story thread, create a new participant
      // relationship to the thread - this will enable us to query against
      // thread.participants as well as have per-thread notifications for a user
      if (message.threadType === 'story' && (thread && !thread.watercooler)) {
        createParticipantInThread(message.threadId, currentUser.id);
      }

      if (thread && thread.watercooler) {
        createParticipantWithoutNotificationsInThread(
          message.threadId,
          currentUser.id
        );
      }

      // all checks passed
      if (message.messageType === 'text' || message.messageType === 'draftjs') {
        if (message.messageType === 'draftjs') {
          debug('draftjs message');
          const parsedMessage = JSON.parse(message.content.body);
          const { blocks } = parsedMessage;
          // Try guessing the language of a code message
          if (blocks && blocks.length > 0 && blocks[0].type === 'code-block') {
            debug('code message found, trying to detect language');
            let lang;
            try {
              lang = detectLang(toPlainText(toState(parsedMessage)));
            } catch (err) {
              console.error(err);
            }
            if (lang && lang !== 'Unknown') {
              debug('code message language is', lang.toLowerCase());
              // Set data.syntax to the language and add that to the message
              parsedMessage.blocks[0].data = {
                syntax: lang.toLowerCase(),
              };
              message.content.body = JSON.stringify(parsedMessage);
            }
          }
        }
        // send a normal text message
        return storeMessage(message, currentUser.id)
          .then(async message => {
            if (message.threadType === 'directMessageThread') return message;
            const { communityId } = await loaders.thread.load(message.threadId);
            const permissions = await loaders.userPermissionsInCommunity.load([
              message.senderId,
              communityId,
            ]);

            return {
              ...message,
              contextPermissions: {
                reputation: permissions ? permissions.reputation : 0,
                isModerator: permissions ? permissions.isModerator : false,
                isOwner: permissions ? permissions.isOwner : false,
              },
            };
          })
          .catch(err => new UserError(err.message));
      } else if (message.messageType === 'media') {
        // upload the photo, return the photo url, then store the message

        return uploadImage(message.file, 'threads', message.threadId)
          .then(url => {
            // build a new message object with a new file field with metadata
            const newMessage = Object.assign({}, message, {
              content: {
                body: url,
              },
              file: {
                name: message.file.name,
                size: message.file.size,
                type: message.file.type,
              },
            });
            return newMessage;
          })
          .then(newMessage => storeMessage(newMessage, currentUser.id))
          .then(async message => {
            if (message.threadType === 'directMessageThread') return message;
            const { communityId } = await loaders.thread.load(message.threadId);
            const permissions = await loaders.userPermissionsInCommunity.load([
              message.senderId,
              communityId,
            ]);

            return {
              ...message,
              contextPermissions: {
                communityId,
                reputation: permissions ? permissions.reputation : 0,
                isModerator: permissions ? permissions.isModerator : false,
                isOwner: permissions ? permissions.isOwner : false,
              },
            };
          })
          .catch(err => new UserError(err.message));
      } else {
        return new UserError('Unknown message type');
      }
    },
    deleteMessage: async (
      _: any,
      { id }: DeleteMessageInput,
      { user }: GraphQLContext
    ) => {
      debug(`delete message#${id}`);
      const currentUser = user;
      if (!currentUser)
        throw new UserError('You must be signed in to delete a message.');

      const message = await getMessage(id);
      if (!message) throw new UserError('This message does not exist.');

      if (message.senderId !== currentUser.id) {
        // Only the sender can delete a directMessageThread message
        if (message.threadType === 'directMessageThread') {
          throw new UserError('You can only delete your own messages.');
        }

        const thread = await getThread(message.threadId);
        const communityPermissions = await getUserPermissionsInCommunity(
          thread.communityId,
          currentUser.id
        );
        const channelPermissions = await getUserPermissionsInChannel(
          thread.channelId,
          currentUser.id
        );
        const canModerate =
          channelPermissions.isOwner ||
          communityPermissions.isOwner ||
          channelPermissions.isModerator ||
          communityPermissions.isModerator;
        if (!canModerate)
          throw new UserError(
            "You don't have permission to delete this message."
          );
      }

      // Delete message and remove participant from thread if it's the only message from that person
      debug(`permission checks pass, actually delete message#${id}`);
      return deleteMessage(currentUser.id, id).then(() => {
        // We don't need to delete participants of direct message threads
        if (message.threadType === 'directMessageThread') return true;

        debug('thread message, check if user has more messages in thread');
        return userHasMessagesInThread(
          message.threadId,
          message.senderId
        ).then(hasMoreMessages => {
          if (hasMoreMessages) return true;
          debug('user has no more messages, delete userThread record');
          return deleteParticipantInThread(
            message.threadId,
            message.senderId
          ).then(() => true);
        });
      });
    },
  },
};
