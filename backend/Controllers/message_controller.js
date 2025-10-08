const Message = require('../Models/Message.js');
const Conversation = require('../Models/Conversation.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const imageupload = require('../config/imageupload.js');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const {
  AWS_BUCKET_NAME,
  AWS_SECRET,
  AWS_ACCESS_KEY,
} = require('../secrets.js');

const { S3Client } = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');

// Initialize Google Generative AI with updated model
const configuration = new GoogleGenerativeAI(process.env.GENERATIVE_API_KEY);
const modelId = 'gemini-2.5-flash'; // Updated model
const model = configuration.getGenerativeModel({ model: modelId });

// SEND MESSAGE (User to User)
const sendMessage = async (req, res) => {
  try {
    const { conversationId, sender, text } = req.body;
    if (!conversationId || !sender || !text) {
      return res.status(400).json({ error: 'Please fill all the fields' });
    }

    let imageurl = '';
    if (req.file) {
      imageurl = await imageupload(req.file, false);
    }

    const conversation = await Conversation.findById(conversationId).populate(
      'members',
      '-password'
    );

    // Check if conversation contains a bot
    const isBot = conversation.members.some(
      member => member != sender && member.email.includes('bot')
    );

    if (!isBot) {
      const newMessage = new Message({
        conversationId,
        sender,
        text,
        imageurl,
        seenBy: [sender],
      });

      await newMessage.save();
      conversation.updatedAt = new Date();
      await conversation.save();

      return res.json(newMessage);
    }
  } catch (error) {
    console.error(error.message);
    return res.status(500).send('Internal Server Error');
  }
};

// GET ALL MESSAGES
const allMessage = async (req, res) => {
  try {
    const messages = await Message.find({
      conversationId: req.params.id,
      deletedFrom: { $ne: req.user.id },
    });

    for (const message of messages) {
      if (
        !message.seenBy.some(
          element => element.user.toString() === req.user.id.toString()
        )
      ) {
        message.seenBy.push({ user: req.user.id });
        await message.save();
      }
    }

    return res.json(messages);
  } catch (error) {
    console.error(error.message);
    return res.status(500).send('Internal Server Error');
  }
};

// DELETE MESSAGE
const deletemesage = async (req, res) => {
  const { messageid, userids } = req.body;
  try {
    const message = await Message.findById(messageid);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    userids.forEach(userid => {
      if (!message.deletedFrom.includes(userid)) {
        message.deletedFrom.push(userid);
      }
    });

    await message.save();
    return res.status(200).send('Message deleted successfully');
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// PRESIGNED URL FOR UPLOAD
const getPresignedUrl = async (req, res) => {
  const { filename, filetype } = req.query;
  if (!filename || !filetype)
    return res
      .status(400)
      .json({ error: 'Filename and filetype are required' });

  const validFileTypes = [
    'image/jpeg',
    'image/png',
    'image/jpg',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
  ];

  if (!validFileTypes.includes(filetype))
    return res.status(400).json({ error: 'Invalid file type' });

  const s3Client = new S3Client({
    credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET },
    region: 'ap-south-1',
  });

  try {
    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: AWS_BUCKET_NAME,
      Key: `conversa/${req.user.id}/${Math.random()}/${filename}`,
      Conditions: [['content-length-range', 0, 5 * 1024 * 1024]],
      Fields: { success_action_status: '201' },
      Expires: 15 * 60,
    });

    return res.status(200).json({ url, fields });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// GET AI RESPONSE
const getAiResponse = async (prompt, senderId, conversationId) => {
  try {
    const conversation = await Conversation.findById(conversationId);
    const botId = conversation.members.find(member => member != senderId);

    if (!botId) throw new Error('No bot found in conversation');

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(20);

    const chatHistory = messages.reverse().map(msg => ({
      role: msg.senderId === senderId ? 'user' : 'assistant',
      content: msg.text || '',
    }));

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: { maxOutputTokens: 2000 },
    });
    const result = await chat.sendMessage(prompt);
    const responseText =
      result.response.text() || 'Woops!! ask me something shorter.';

    // Save user message
    await Message.create({
      conversationId,
      senderId,
      text: prompt,
      seenBy: [{ user: botId, seenAt: new Date() }],
    });

    // Save bot response
    const botMessage = await Message.create({
      conversationId,
      senderId: botId,
      text: responseText,
    });

    conversation.latestmessage = responseText;
    await conversation.save();

    return botMessage;
  } catch (error) {
    console.error(error.message);
    return { error: 'Failed to generate AI response' };
  }
};

// SEND MESSAGE HANDLER (Socket)
const sendMessageHandler = async data => {
  const {
    text,
    imageUrl,
    senderId,
    conversationId,
    receiverId,
    isReceiverInsideChatRoom,
  } = data;
  const conversation = await Conversation.findById(conversationId);

  if (!isReceiverInsideChatRoom) {
    const message = await Message.create({
      conversationId,
      senderId,
      text,
      imageUrl,
      seenBy: [],
    });

    conversation.latestmessage = text;
    conversation.unreadCounts.forEach(unread => {
      if (unread.userId.toString() === receiverId.toString()) unread.count += 1;
    });
    await conversation.save();
    return message;
  } else {
    const message = await Message.create({
      conversationId,
      senderId,
      text,
      seenBy: [{ user: receiverId, seenAt: new Date() }],
    });

    conversation.latestmessage = text;
    await conversation.save();
    return message;
  }
};

// DELETE MESSAGE HANDLER (Socket)
const deleteMessageHandler = async data => {
  const { messageId, deleteFrom } = data;
  const message = await Message.findById(messageId);
  if (!message) return false;

  deleteFrom.forEach(userId => {
    if (!message.deletedFrom.includes(userId)) message.deletedFrom.push(userId);
  });

  await message.save();
  return true;
};

module.exports = {
  sendMessage,
  allMessage,
  getPresignedUrl,
  getAiResponse,
  deletemesage,
  sendMessageHandler,
  deleteMessageHandler,
};
