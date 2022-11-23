const express = require('express');
const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const { QuickDB } = require("quick.db");
const db = new QuickDB({filePath: "Data/db.sqlite"});
const connectedPlayers = new Map();

const gameMap = getMap();


// Game class

class Game{
	constructor(){
    this.money = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.location = 'spawnpoint';
  	this.items = [];
    this.alliances = [];
  }
}


// Server

http.listen(8000, () => {
  console.log('Server online');
});

app.get('/map',function(req,res) {
  res.sendFile(path.join(__dirname + '/Map/map.json'));
});

app.use(express.static(path.join(__dirname + '/Public')));


// Socket.io

io.on('connection', (socket) => {
  // Set up and login/create account
  (async function(){
    const username = socket.handshake.headers['x-replit-user-name'];
    
    if((!username) || (connectedPlayers.has(username))){
      socket.disconnect();
    } else {
      let user = await db.get(username);
  
      if(user == undefined) user = await createAccount(username);

      connectedPlayers.set(username, user);
  
      socket.emit('loggedIn', user);
    }
  })();

  socket.on('action', function(actionObj) {
    const username = socket.handshake.headers['x-replit-user-name'];

    playAction(username, socket, actionObj);
  });

  socket.on('disconnect', function() {
    const username = socket.handshake.headers['x-replit-user-name'];
    
    if(connectedPlayers.has(username)){
      connectedPlayers.delete(username);
    }
  });
});


// Accounts

async function createAccount(username){
  const userObj = {
    username: username,
    game: new Game()
  }

  await db.set(username, userObj);
  return userObj;
}


// Map

function getMap(){
  const map = JSON.parse(fs.readFileSync('Map/map.json'));
  const backup = JSON.parse(fs.readFileSync('Map/backup.json'));

  if(isEmpty('Map/map.json') && !(isEmpty('Map/backup.json'))){
    fs.writeFileSync('Map/map.json', JSON.stringify(backup));
  }

  if(!(isEmpty('Map/map.json')) && isEmpty('Map/backup.json')){
    fs.writeFileSync('Map/backup.json', JSON.stringify(map));
  }

  if(isEmpty('Map/map.json') && isEmpty('Map/backup.json')){
    console.log('Map files are empty.');
  }

  return JSON.parse(fs.readFileSync('Map/map.json'));
}

function isEmpty(path) {
  const file = fs.readFileSync(path);
  for(var key in file) {
    if(file.hasOwnProperty(key) && Object.keys(JSON.parse(file)).length !== 0)
      return false;
    }
  return true;
}

// Game


async function playAction(username, socket, actionObj){
  const user = await db.get(username);
  //console.log(user)
  if(user == undefined) return;

  const command = (actionObj.command).toLowerCase();
  const args = (actionObj.args).map(elem => {
    return elem.toLowerCase();
  });

  if(command == 'move'){
    // Moving system
    const destinationName = gameMap[user.game.location].neighbors[args[0]];
    const destination = gameMap[destinationName];
    if(destination == undefined) return socket.emit('message', 'That is not an available action.');

    let cannotPass = false;
    
    for(let item of destination.neededToEnter){
      if(!((user.game.items).includes(item))){
        cannotPass = true;
        return socket.emit('message', `You need the "${item}" to pass!`);
      }
    }

    if(cannotPass == true) return;
    
    let newUser = user;
    newUser.game.location = destinationName;
    
    await db.set(username, newUser);
    
    return socket.emit('gameUpdate', newUser);
  } else if(command == 'talk'){
    // NPC Interaction system
    const availableNPCs = gameMap[user.game.location].npcs;
    const targetNPC= availableNPCs[args[0]];

    if(targetNPC == undefined) return socket.emit('message', 'That is not an available action.');

    return socket.emit('message', `${targetNPC.name}: ${targetNPC.text}`);
  } else if((command == 'buy') || (command == 'inspect')){
    const currentLocation = gameMap[user.game.location];
    
    // Buying and inspecting items
    let targetItem;

    // Find item in the wares of nearby NPC's
    Object.keys(currentLocation.npcs).forEach(function(key){
      const npc = currentLocation.npcs[key];
      const item = npc.wares[args[0]];
      
      if(item != undefined) targetItem = item;
    });
    
    const item = targetItem;
    
    if(item == undefined) return socket.emit('message', 'That is not an available action.');

    // Inspect
    if(command == 'inspect'){
      return socket.emit('message', `${item.name}: ${item.description}\nPrice: ${item.price}`);
    }

    // Buy
    // Make sure user doesn't already have the item
    if(user.game.items.includes(item.name)) return socket.emit('message', 'You already own this item!');
    
    // Make sure user has enough money
    if(user.game.money < item.price) return socket.emit('message', 'You don\'t have enough money to buy this item.');

    let newUser = user;
    newUser.game.money -= item.price;
    newUser.game.items.push(item.name);

    await db.set(username, newUser);

    socket.emit('message', `You purchased the ${item.name}!`);
    return socket.emit('gameUpdate', newUser);
  } else if(command == 'mine'){
    // Mining
    if(user.game.location != 'mine') return socket.emit('message', 'That is not an available action.');

    let mineTime = 1000;
    if(user.game.items.includes('SuperPick')) mineTime = 650;

    let counter = 0;

    socket.emit('message', `Mining... (${counter * 10}%)`);
    const mineInterval = setInterval(function(){
      counter++;
      socket.emit('message', `Mining... (${counter * 10}%)`);

      // Notify and profit when completed
      if(counter >= 10){
        const goldFound = Math.floor(Math.random() * Math.random() * 10);
          
        socket.emit('message', `Finished! Found ${goldFound} gram(s) of gold! Earned $${goldFound * 50}!`);

        // Save profit
        let newUser = user;
        newUser.game.money += (goldFound * 50);
        
        db.set(username, newUser);

        socket.emit('gameUpdate', newUser);
        
        clearInterval(mineInterval);
      }
    }, mineTime);
  } else {
    // Unrecognized command
    return socket.emit('message', 'That is not an available action.');
  }
}