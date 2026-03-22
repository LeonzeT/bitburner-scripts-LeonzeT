/** @param {NS} ns 
 * @param {Document} doc **/
export function terminal(ns, command, doc=eval("document")){
	// Acquire a reference to the terminal text field
	const terminalInput = doc.getElementById("terminal-input");
	if(!terminalInput){
		return false;
	}
	if(terminalInput.value !== ""){
		return false;
	}
	// Set the value to the command you want to run.
	terminalInput.value=command;
	// Get a reference to the React event handler.
	const handler = Object.keys(terminalInput)[1];
	// Perform an onChange event to set some internal values.
	terminalInput[handler].onChange({target:terminalInput});
	// Simulate an enter press
	terminalInput[handler].onKeyDown({key: 'Enter',preventDefault:()=>null});
	return true;
}

export async function main(ns){
	while(true){
		terminal(ns, 'hack');
		await ns.sleep(450);
	}
}