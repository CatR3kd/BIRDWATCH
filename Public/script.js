(() => {	
  socket = io();
  let map;
  let savedUser;

  fetch('https://ta.catr3kd.repl.co/map')
  .then((response) => response.json())
  .then((data) => {
  	map = data;
  });
  
  socket.on('loggedIn', function(user){
    document.getElementById('login').style.visibility = 'hidden';
    document.getElementById('content').style.visibility = 'visible';
    updateGame({"user": user, "notify": true, "addedMessage": ''});
  });

  socket.on('gameUpdate', function(updateObj){
    updateGame(updateObj);
  });

  socket.on('message', function(message){
    const text = document.getElementById('text');
    text.innerText = `${text.innerText}${message}\n\n`;
    scroll();
  });
  
  document.getElementById('actionInput').addEventListener('keyup', function(event) {
    if(event.keyCode === 13){
      event.preventDefault();
      sendAction();
    }
  });
  
  function sendAction(){
    const input = document.getElementById('actionInput');
    const action = input.value;
    let args = action.split(' ');
    const command = args[0];
    args.shift();
    input.value = '';
  
    const actionObj = {
      command: command,
      args: args
    };

    if(command.toLowerCase() == 'help') return help();
    if(command.toLowerCase() == 'location') return whereAmI();
    if(command.toLowerCase() == 'balance') return balance();
    if(command.toLowerCase() == 'inventory') return inventory();
    if(command.toLowerCase() == 'health') return health();
    
    socket.emit('action', actionObj);
  }

  function help(){
    const text = document.getElementById('text');
    
    text.innerText = text.innerText + `Use commands to navigate and interact with the game!
    Global commands:
    "location" Reminds you of your surroundings.
    "health": Tells you how much health you have left.
    "balance" Tells you how much money you have.
    "inventory" Shows you what items you own.
    "move {direction}" Moves you in a given direction. (North, South, East, West)
    NOTE: There are other location-specific commands that will be explained by other characters.\n\n`;
    
    scroll();
  }

  function whereAmI(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Entered ${map[savedUser.game.location].name}.\n${map[savedUser.game.location].text}\n\n`;
    
    scroll();
  }

  function balance(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Current balance: $${savedUser.game.money}\n\n`;
    
    scroll();
  }

  function health(){
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}Current HP: ${savedUser.game.health}/${savedUser.game.maxHealth}\n\n`;
    
    scroll();
  }

  function inventory(){
    const inventory = savedUser.game.items;
    let textToDisplay = '';

    if(inventory.length <= 0){
      textToDisplay = 'Your inventory is empty!';
    } else {
      textToDisplay = 'Your items:';
      for(let item of inventory){
        textToDisplay += `\n${item}`;
      }
    }
    
    const text = document.getElementById('text');
    
    text.innerText = `${text.innerText}${textToDisplay}\n\n`;
    
    scroll();
  }

  function updateGame(updateObj){
    savedUser = updateObj.user;
    
    if(updateObj.notify == true){
      const text = document.getElementById('text');
      
      text.innerText = `${text.innerText}Entered ${map[updateObj.user.game.location].name}.\n${map[updateObj.user.game.location].text}${updateObj.addedMessage}\n\n`;
      
      scroll();
    }
  }

  function scroll(){
    const terminal = document.getElementById('terminal');
    terminal.scrollTop = terminal.scrollHeight;
  }
})()