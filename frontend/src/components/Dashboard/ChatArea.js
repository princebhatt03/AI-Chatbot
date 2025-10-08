import React, { useState, useEffect, useContext } from 'react';
import { ArrowForwardIcon } from '@chakra-ui/icons';
import Lottie from 'react-lottie';
import animationdata from '../../typingAnimation.json';
import {
  Box,
  InputGroup,
  Input,
  Text,
  InputRightElement,
  Button,
  FormControl,
  InputLeftElement,
  useToast,
  useDisclosure,
} from '@chakra-ui/react';
import { FaFileUpload } from 'react-icons/fa';
import { marked } from 'marked';

import chatContext from '../../context/chatContext';
import ChatAreaTop from './ChatAreaTop';
import FileUploadModal from '../miscellaneous/FileUploadModal';
import ChatLoadingSpinner from '../miscellaneous/ChatLoadingSpinner';
import SingleMessage from './SingleMessage';
import axios from 'axios';

const scrollbarconfig = {
  '&::-webkit-scrollbar': { width: '5px', height: '5px' },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: 'gray.300',
    borderRadius: '5px',
  },
  '&::-webkit-scrollbar-thumb:hover': { backgroundColor: 'gray.400' },
  '&::-webkit-scrollbar-track': { display: 'none' },
};

// Safe markdown conversion
const markdownToHtml = markdownText => {
  if (!markdownText || typeof markdownText !== 'string') return { __html: '' };
  return { __html: marked(markdownText) };
};

export const ChatArea = () => {
  const context = useContext(chatContext);
  const {
    hostName,
    user,
    receiver,
    socket,
    activeChatId,
    messageList,
    setMessageList,
    isOtherUserTyping,
    setIsOtherUserTyping,
    setActiveChatId,
    setReceiver,
    setMyChatList,
    myChatList,
    isChatLoading,
  } = context;

  const [typing, setTyping] = useState(false);
  const toast = useToast();
  const { isOpen, onOpen, onClose } = useDisclosure();

  // Lottie options for typing animation
  const defaultOptions = {
    loop: true,
    autoplay: true,
    animationData: animationdata,
    rendererSettings: { preserveAspectRatio: 'xMidYMid slice' },
  };

  // --- Socket event handlers ---
  useEffect(() => {
    // Handle incoming events
    socket.on('user-joined-room', userId => {
      setMessageList(prev =>
        prev.map(message => {
          if (message.senderId === user._id && userId !== user._id) {
            if (!message.seenBy.some(s => s.user === userId)) {
              message.seenBy.push({ user: userId, seenAt: new Date() });
            }
          }
          return message;
        })
      );
    });

    socket.on('typing', data => {
      if (data.typer !== user._id) setIsOtherUserTyping(true);
    });

    socket.on('stop-typing', data => {
      if (data.typer !== user._id) setIsOtherUserTyping(false);
    });

    socket.on('receive-message', data => {
      setMessageList(prev => [...prev, data]);
      setTimeout(() => {
        document.getElementById('chat-box')?.scrollTo({
          top: document.getElementById('chat-box').scrollHeight,
          behavior: 'smooth',
        });
      }, 100);
    });

    socket.on('message-deleted', data => {
      setMessageList(prev => prev.filter(msg => msg._id !== data.messageId));
    });

    return () => {
      socket.off('typing');
      socket.off('stop-typing');
      socket.off('receive-message');
      socket.off('message-deleted');
    };
  }, [socket, user._id, setMessageList, setIsOtherUserTyping]);

  // --- Typing events ---
  const handleTyping = () => {
    const input = document.getElementById('new-message');
    if (!input) return;

    if (input.value === '' && typing) {
      setTyping(false);
      socket.emit('stop-typing', {
        typer: user._id,
        conversationId: activeChatId,
      });
    } else if (input.value !== '' && !typing) {
      setTyping(true);
      socket.emit('typing', { typer: user._id, conversationId: activeChatId });
    }
  };

  const handleKeyPress = e => {
    if (e.key === 'Enter') handleSendMessage(e);
  };

  // --- File upload helper ---
  const getPreSignedUrl = async (fileName, fileType) => {
    if (!fileName || !fileType) return;
    try {
      const response = await axios.get(
        `${hostName}/user/presigned-url?filename=${fileName}&filetype=${fileType}`,
        { headers: { 'auth-token': localStorage.getItem('token') } }
      );
      return response.data;
    } catch (error) {
      toast({
        title: error.message,
        status: 'error',
        duration: 3000,
        isClosable: true,
      });
    }
  };

  // --- Send message ---
  const handleSendMessage = async (e, messageText, file) => {
    e.preventDefault();
    const awsHost = 'https://conversa-chat.s3.ap-south-1.amazonaws.com/';

    if (!messageText)
      messageText = document.getElementById('new-message')?.value || '';

    socket.emit('stop-typing', {
      typer: user._id,
      conversationId: activeChatId,
    });

    if (messageText === '' && !file) {
      toast({
        title: 'Message cannot be empty',
        status: 'warning',
        duration: 3000,
        isClosable: true,
      });
      return;
    }

    let key = null;

    if (file) {
      try {
        const { url, fields } = await getPreSignedUrl(file.name, file.type);
        const formData = new FormData();
        Object.entries({ ...fields, file }).forEach(([k, v]) =>
          formData.append(k, v)
        );
        const response = await axios.post(url, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        if (response.status !== 201) throw new Error('Failed to upload file');
        key = fields.key;
      } catch (error) {
        toast({
          title: error.message,
          status: 'error',
          duration: 3000,
          isClosable: true,
        });
        return;
      }
    }

    const data = {
      text: messageText,
      conversationId: activeChatId,
      senderId: user._id,
      imageUrl: file ? `${awsHost}${key}` : null,
    };
    socket.emit('send-message', data);

    const inputElem = document.getElementById('new-message');
    if (inputElem) inputElem.value = '';

    setTimeout(() => {
      document.getElementById('chat-box')?.scrollTo({
        top: document.getElementById('chat-box').scrollHeight,
        behavior: 'smooth',
      });
    }, 100);

    // Update chat list
    setMyChatList(
      myChatList
        .map(chat => {
          if (chat._id === activeChatId) {
            chat.latestmessage = messageText;
            chat.updatedAt = new Date().toUTCString();
          }
          return chat;
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    );
  };

  const removeMessageFromList = messageId =>
    setMessageList(prev => prev.filter(msg => msg._id !== messageId));

  return (
    <>
      {activeChatId ? (
        <Box
          justifyContent="space-between"
          h="100%"
          w={{ base: '100vw', md: '100%' }}>
          <ChatAreaTop />
          {isChatLoading && <ChatLoadingSpinner />}
          <Box
            id="chat-box"
            h="85%"
            overflowY="auto"
            sx={scrollbarconfig}
            mt={1}
            mx={1}>
            {messageList?.map(message =>
              !message.deletedby?.includes(user._id) ? (
                <SingleMessage
                  key={message._id}
                  message={message}
                  user={user}
                  receiver={receiver}
                  markdownToHtml={markdownToHtml}
                  scrollbarconfig={scrollbarconfig}
                  socket={socket}
                  activeChatId={activeChatId}
                  removeMessageFromList={removeMessageFromList}
                  toast={toast}
                />
              ) : null
            )}
          </Box>

          <Box
            py={2}
            position="fixed"
            w={{ base: '100%', md: '70%' }}
            bottom={{ base: 1, md: 3 }}
            bg={
              localStorage.getItem('chakra-ui-color-mode') === 'dark'
                ? '#1a202c'
                : 'white'
            }>
            <Box
              mx={{ base: 6, md: 3 }}
              w="fit-content">
              {isOtherUserTyping && (
                <Lottie
                  options={defaultOptions}
                  height={20}
                  width={20}
                />
              )}
            </Box>
            <FormControl>
              <InputGroup
                w={{ base: '95%', md: '98%' }}
                m="auto"
                onKeyDown={handleKeyPress}>
                {!receiver?.email?.includes('bot') && (
                  <InputLeftElement>
                    <Button
                      mx={2}
                      size="sm"
                      onClick={onOpen}
                      borderRadius="lg">
                      <FaFileUpload />
                    </Button>
                  </InputLeftElement>
                )}
                <Input
                  placeholder="Type a message"
                  id="new-message"
                  onChange={handleTyping}
                  borderRadius="10px"
                />
                <InputRightElement>
                  <Button
                    onClick={e =>
                      handleSendMessage(
                        e,
                        document.getElementById('new-message')?.value
                      )
                    }
                    size="sm"
                    mx={2}
                    borderRadius="10px">
                    <ArrowForwardIcon />
                  </Button>
                </InputRightElement>
              </InputGroup>
            </FormControl>
          </Box>
          <FileUploadModal
            isOpen={isOpen}
            onClose={onClose}
            handleSendMessage={handleSendMessage}
          />
        </Box>
      ) : (
        !isChatLoading && (
          <Box
            display={{ base: 'none', md: 'block' }}
            mx="auto"
            w="fit-content"
            mt="30vh"
            textAlign="center">
            <Text
              fontSize="6vw"
              fontWeight="bold"
              fontFamily="Work sans">
              Conversa
            </Text>
            <Text fontSize="2vw">Online chatting app</Text>
            <Text fontSize="md">Select a chat to start messaging</Text>
          </Box>
        )
      )}
    </>
  );
};
